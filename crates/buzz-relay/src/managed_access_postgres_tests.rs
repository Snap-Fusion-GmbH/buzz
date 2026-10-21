//! Production-path regressions for directory-managed channel and socket access.

use std::{
    collections::HashMap,
    sync::{atomic::AtomicU8, Arc},
    time::Duration,
};

use nostr::{EventBuilder, Keys, Kind, Tag};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    api::relay_members::{check_relay_membership, MembershipDecision},
    handlers::{
        group_state_postgres_tests::{community, create_channel, http_auth, state},
        ingest::ingest_event,
    },
    managed_access::{enforce_sessions, ManagedAccessPolicy},
    state::{AppState, CommunityConnectionControl},
};

fn policy(controller: &Keys) -> ManagedAccessPolicy {
    policy_with_agents(controller, false)
}

fn policy_with_agents(controller: &Keys, allow_agents: bool) -> ManagedAccessPolicy {
    let owner = controller.public_key().to_hex();
    ManagedAccessPolicy::parse(
        &serde_json::json!({
            "controller_pubkey": owner,
            "membership_ttl_seconds": 60,
            "allow_owner_attested_agents": allow_agents,
        })
        .to_string(),
        true,
        false,
        Some(&owner),
    )
    .unwrap()
}

async fn managed_state(controller: &Keys) -> Arc<AppState> {
    managed_state_with_agents(controller, false).await
}

async fn managed_state_with_agents(controller: &Keys, allow_agents: bool) -> Arc<AppState> {
    let raw = state().await;
    let mut raw = Arc::try_unwrap(raw).unwrap_or_else(|arc| (*arc).clone());
    let mut config = (*raw.config).clone();
    config.require_relay_membership = true;
    config.relay_owner_pubkey = Some(controller.public_key().to_hex());
    config.managed_access = Some(policy_with_agents(controller, allow_agents));
    raw.config = Arc::new(config);
    Arc::new(raw)
}

fn command(keys: &Keys, kind: u16, channel: Uuid, extra: Vec<Tag>) -> nostr::Event {
    EventBuilder::new(Kind::Custom(kind), "")
        .tag(Tag::parse(["h", &channel.to_string()]).unwrap())
        .tags(extra)
        .sign_with_keys(keys)
        .unwrap()
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn managed_channel_members_cannot_invite_or_reconfigure_source_access() {
    let controller = Keys::generate();
    let member = Keys::generate();
    let outsider = Keys::generate();
    let state = managed_state(&controller).await;
    let tenant = community(&state, "managed-channel-authority").await;
    let channel = create_channel(&state, &tenant, &controller, &[&["visibility", "private"]]).await;
    let add = command(
        &controller,
        9000,
        channel,
        vec![
            Tag::parse(["p", &member.public_key().to_hex()]).unwrap(),
            Tag::parse(["role", "member"]).unwrap(),
        ],
    );
    ingest_event(&state, &tenant, add, http_auth(&controller))
        .await
        .expect("controller grants source-authorized membership");

    for (kind, tags) in [
        (
            9000,
            vec![Tag::parse(["p", &outsider.public_key().to_hex()]).unwrap()],
        ),
        (9002, vec![Tag::parse(["visibility", "open"]).unwrap()]),
        (9008, vec![]),
    ] {
        let attempt = command(&member, kind, channel, tags);
        let error = ingest_event(&state, &tenant, attempt, http_auth(&member))
            .await
            .err()
            .expect("ordinary members cannot change managed source access");
        assert!(format!("{error:?}").contains("managed by the directory"));
    }
    assert!(!state
        .db
        .get_members(tenant.community(), channel)
        .await
        .unwrap()
        .iter()
        .any(|record| record.pubkey == outsider.public_key().to_bytes()));

    // The same deployment retains ordinary behavior on independently created
    // channels; the controller policy is not a blanket channel-admin takeover.
    let independent = create_channel(&state, &tenant, &member, &[&["visibility", "private"]]).await;
    let invite = command(
        &member,
        9000,
        independent,
        vec![Tag::parse(["p", &outsider.public_key().to_hex()]).unwrap()],
    );
    ingest_event(&state, &tenant, invite, http_auth(&member))
        .await
        .expect("independent channel permissions are preserved");
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn expired_writer_membership_is_denied_without_deleting_the_roster_row() {
    let controller = Keys::generate();
    let member = Keys::generate();
    let state = managed_state(&controller).await;
    let tenant = community(&state, "managed-membership-expiry").await;
    let _ = state
        .db
        .add_relay_member(
            tenant.community(),
            &member.public_key().to_hex(),
            "member",
            Some(&controller.public_key().to_hex()),
            &state.relay_keypair,
        )
        .await
        .unwrap();
    let member_bytes = member.public_key().to_bytes();
    let decision = || check_relay_membership(&state, tenant.community(), &member_bytes, None, None);
    assert_eq!(decision().await.unwrap(), MembershipDecision::Member);
    let invitee = Keys::generate();
    let _ = state
        .db
        .add_relay_member(
            tenant.community(),
            &invitee.public_key().to_hex(),
            "member",
            Some("invite"),
            &state.relay_keypair,
        )
        .await
        .unwrap();
    assert_eq!(
        check_relay_membership(
            &state,
            tenant.community(),
            &invitee.public_key().to_bytes(),
            None,
            None,
        )
        .await
        .unwrap(),
        MembershipDecision::Denied,
        "an ordinary invite must not bypass directory enrollment even briefly"
    );
    sqlx::query(
        "UPDATE relay_members SET updated_at=now()-interval '61 seconds' \
         WHERE community_id=$1 AND pubkey=$2",
    )
    .bind(tenant.community().as_uuid())
    .bind(member.public_key().to_hex())
    .execute(state.db.pool())
    .await
    .unwrap();
    assert!(state
        .db
        .is_relay_member_writer(tenant.community(), &member.public_key().to_hex())
        .await
        .unwrap());
    assert_eq!(decision().await.unwrap(), MembershipDecision::Denied);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn expired_leases_close_root_and_audio_sessions_when_controller_is_absent() {
    let controller = Keys::generate();
    let member = Keys::generate();
    let state = managed_state(&controller).await;
    let tenant = community(&state, "managed-live-expiry").await;
    let _ = state
        .db
        .add_relay_member(
            tenant.community(),
            &member.public_key().to_hex(),
            "member",
            Some(&controller.public_key().to_hex()),
            &state.relay_keypair,
        )
        .await
        .unwrap();
    let root_cancel = CancellationToken::new();
    let root_control = CommunityConnectionControl::new(root_cancel.clone());
    let root_id = Uuid::new_v4();
    let (tx, _rx) = mpsc::channel(8);
    let (ctrl_tx, _ctrl_rx) = mpsc::channel(8);
    let (terminal_tx, _terminal_rx) = mpsc::channel(1);
    state.conn_manager.register(
        root_id,
        tx,
        ctrl_tx,
        terminal_tx,
        None,
        root_cancel.clone(),
        tenant.community(),
        Arc::new(AtomicU8::new(0)),
        Arc::new(Mutex::new(HashMap::new())),
        3,
        root_control,
    );
    state
        .conn_manager
        .set_authenticated_pubkey(root_id, member.public_key().to_bytes().to_vec());
    let audio_cancel = CancellationToken::new();
    let audio_control = CommunityConnectionControl::new(audio_cancel.clone());
    audio_control.bind_pubkey(member.public_key().to_bytes());
    let _audio_registration =
        state
            .community_connections
            .register(Uuid::new_v4(), tenant.community(), audio_control);
    let policy = policy(&controller);
    enforce_sessions(&state, &policy).await;
    assert!(!root_cancel.is_cancelled());
    assert!(!audio_cancel.is_cancelled());
    sqlx::query(
        "UPDATE relay_members SET updated_at=now()-interval '61 seconds' \
         WHERE community_id=$1 AND pubkey=$2",
    )
    .bind(tenant.community().as_uuid())
    .bind(member.public_key().to_hex())
    .execute(state.db.pool())
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(4), enforce_sessions(&state, &policy))
        .await
        .expect("expiry backstop is bounded");
    assert!(root_cancel.is_cancelled());
    assert!(audio_cancel.is_cancelled());
    state.conn_manager.deregister(root_id);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn managed_agents_need_verified_ownership_and_a_current_same_community_owner_lease() {
    let controller = Keys::generate();
    let owner = Keys::generate();
    let agent = Keys::generate();
    let stranger = Keys::generate();
    let state = managed_state_with_agents(&controller, true).await;
    let tenant = community(&state, "managed-agent-admission").await;
    let other = community(&state, "managed-agent-other-community").await;
    let timestamp = nostr::Timestamp::now().as_secs();
    let tag = buzz_sdk::nip_oa::compute_auth_tag(&owner, &agent.public_key(), "").unwrap();
    let wrong_agent_tag =
        buzz_sdk::nip_oa::compute_auth_tag(&owner, &stranger.public_key(), "").unwrap();
    let expired_tag =
        buzz_sdk::nip_oa::compute_auth_tag(&owner, &agent.public_key(), "created_at<1").unwrap();
    let mut forged_tag: serde_json::Value = serde_json::from_str(&tag).unwrap();
    forged_tag[3] = serde_json::json!("0".repeat(128));
    let forged_tag = forged_tag.to_string();
    let _ = state
        .db
        .add_relay_member(
            tenant.community(),
            &owner.public_key().to_hex(),
            "member",
            Some(&controller.public_key().to_hex()),
            &state.relay_keypair,
        )
        .await
        .unwrap();
    let agent_bytes = agent.public_key().to_bytes();
    for (candidate, signed_time) in [
        (None, Some(timestamp)),
        (Some(tag.as_str()), None),
        (Some(wrong_agent_tag.as_str()), Some(timestamp)),
        (Some(expired_tag.as_str()), Some(timestamp)),
        (Some(forged_tag.as_str()), Some(timestamp)),
    ] {
        assert_eq!(
            check_relay_membership(
                &state,
                tenant.community(),
                &agent_bytes,
                candidate,
                signed_time,
            )
            .await
            .unwrap(),
            MembershipDecision::Denied,
        );
    }
    assert_eq!(
        check_relay_membership(
            &state,
            tenant.community(),
            &agent_bytes,
            Some(&tag),
            Some(timestamp),
        )
        .await
        .unwrap(),
        MembershipDecision::ViaOwner(owner.public_key()),
    );
    assert!(!state.config.allow_nip_oa_auth);
    assert!(!state
        .db
        .is_relay_member_writer(tenant.community(), &agent.public_key().to_hex())
        .await
        .unwrap());
    assert_eq!(
        check_relay_membership(
            &state,
            other.community(),
            &agent_bytes,
            Some(&tag),
            Some(timestamp),
        )
        .await
        .unwrap(),
        MembershipDecision::Denied,
        "an owner lease in one community must not admit agents to another",
    );
    let successor = Keys::generate();
    let chained_tag =
        buzz_sdk::nip_oa::compute_auth_tag(&agent, &successor.public_key(), "").unwrap();
    assert_eq!(
        check_relay_membership(
            &state,
            tenant.community(),
            &successor.public_key().to_bytes(),
            Some(&chained_tag),
            Some(timestamp),
        )
        .await
        .unwrap(),
        MembershipDecision::Denied,
        "derived membership must not grant onward delegation",
    );
    for (origin, seconds) in [
        (Some(controller.public_key().to_hex()), -61),
        (Some(controller.public_key().to_hex()), 1),
        (Some(stranger.public_key().to_hex()), 0),
        (Some("invite".to_string()), 0),
        (None, 0),
    ] {
        sqlx::query(
            "UPDATE relay_members SET added_by=$3, \
             updated_at=now()+make_interval(secs => $4) \
             WHERE community_id=$1 AND pubkey=$2",
        )
        .bind(tenant.community().as_uuid())
        .bind(owner.public_key().to_hex())
        .bind(origin)
        .bind(f64::from(seconds))
        .execute(state.db.pool())
        .await
        .unwrap();
        assert_eq!(
            check_relay_membership(
                &state,
                tenant.community(),
                &agent_bytes,
                Some(&tag),
                Some(timestamp),
            )
            .await
            .unwrap(),
            MembershipDecision::Denied,
            "expired, future or non-controller-issued owner leases cannot admit agents",
        );
    }
    let _ = state
        .db
        .add_relay_member(
            tenant.community(),
            &controller.public_key().to_hex(),
            "owner",
            None,
            &state.relay_keypair,
        )
        .await
        .unwrap();
    let controller_tag =
        buzz_sdk::nip_oa::compute_auth_tag(&controller, &agent.public_key(), "").unwrap();
    assert_eq!(
        check_relay_membership(
            &state,
            tenant.community(),
            &agent_bytes,
            Some(&controller_tag),
            Some(timestamp),
        )
        .await
        .unwrap(),
        MembershipDecision::Denied,
    );

    let disabled = managed_state(&controller).await;
    let disabled_tenant = community(&disabled, "managed-agents-disabled").await;
    let _ = disabled
        .db
        .add_relay_member(
            disabled_tenant.community(),
            &owner.public_key().to_hex(),
            "member",
            Some(&controller.public_key().to_hex()),
            &disabled.relay_keypair,
        )
        .await
        .unwrap();
    assert_eq!(
        check_relay_membership(
            &disabled,
            disabled_tenant.community(),
            &agent_bytes,
            Some(&tag),
            Some(timestamp),
        )
        .await
        .unwrap(),
        MembershipDecision::Denied,
        "existing managed deployments remain closed to agents until opted in",
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn managed_agent_cannot_switch_its_recorded_owner_to_bypass_expiry() {
    let controller = Keys::generate();
    let owner = Keys::generate();
    let replacement = Keys::generate();
    let agent = Keys::generate();
    let state = managed_state_with_agents(&controller, true).await;
    let tenant = community(&state, "managed-agent-fixed-owner").await;
    for human in [&owner, &replacement] {
        let _ = state
            .db
            .add_relay_member(
                tenant.community(),
                &human.public_key().to_hex(),
                "member",
                Some(&controller.public_key().to_hex()),
                &state.relay_keypair,
            )
            .await
            .unwrap();
    }
    assert!(
        crate::api::relay_members::materialize_nip_oa_owner(
            &state,
            &tenant,
            &agent.public_key(),
            &owner.public_key(),
        )
        .await
    );
    sqlx::query(
        "UPDATE relay_members SET updated_at=now()-interval '61 seconds' \
         WHERE community_id=$1 AND pubkey=$2",
    )
    .bind(tenant.community().as_uuid())
    .bind(owner.public_key().to_hex())
    .execute(state.db.pool())
    .await
    .unwrap();
    let replacement_tag =
        buzz_sdk::nip_oa::compute_auth_tag(&replacement, &agent.public_key(), "").unwrap();
    let timestamp = nostr::Timestamp::now().as_secs();
    assert_eq!(
        check_relay_membership(
            &state,
            tenant.community(),
            agent.public_key().as_bytes(),
            Some(&replacement_tag),
            Some(timestamp),
        )
        .await
        .unwrap(),
        MembershipDecision::Denied,
        "HTTP and sockets must reject the same conflicting owner credential",
    );
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn managed_agent_root_and_audio_sessions_follow_owner_renewal_expiry_and_removal() {
    let controller = Keys::generate();
    let owner = Keys::generate();
    let agent = Keys::generate();
    let state = managed_state_with_agents(&controller, true).await;
    let tenant = community(&state, "managed-agent-live-lease").await;
    let _ = state
        .db
        .add_relay_member(
            tenant.community(),
            &owner.public_key().to_hex(),
            "member",
            Some(&controller.public_key().to_hex()),
            &state.relay_keypair,
        )
        .await
        .unwrap();
    for remove in [false, true] {
        let _ = state
            .db
            .update_relay_member_role(
                tenant.community(),
                &owner.public_key().to_hex(),
                "member",
                &state.relay_keypair,
            )
            .await
            .unwrap();
        let root_cancel = CancellationToken::new();
        let root_id = Uuid::new_v4();
        let (tx, _rx) = mpsc::channel(8);
        let (ctrl_tx, _ctrl_rx) = mpsc::channel(8);
        let (terminal_tx, _terminal_rx) = mpsc::channel(1);
        state.conn_manager.register(
            root_id,
            tx,
            ctrl_tx,
            terminal_tx,
            None,
            root_cancel.clone(),
            tenant.community(),
            Arc::new(AtomicU8::new(0)),
            Arc::new(Mutex::new(HashMap::new())),
            3,
            CommunityConnectionControl::new(root_cancel.clone()),
        );
        state
            .conn_manager
            .set_delegated_owner(root_id, owner.public_key().to_bytes());
        state
            .conn_manager
            .set_authenticated_pubkey(root_id, agent.public_key().to_bytes().to_vec());
        let audio_cancel = CancellationToken::new();
        let audio = CommunityConnectionControl::new(audio_cancel.clone());
        audio.bind_delegated_owner(owner.public_key().to_bytes());
        audio.bind_pubkey(agent.public_key().to_bytes());
        let _audio_registration =
            state
                .community_connections
                .register(Uuid::new_v4(), tenant.community(), audio);
        let policy = policy_with_agents(&controller, true);
        enforce_sessions(&state, &policy).await;
        assert!(!root_cancel.is_cancelled());
        assert!(!audio_cancel.is_cancelled());
        if remove {
            let _ = state
                .db
                .remove_relay_member(
                    tenant.community(),
                    &owner.public_key().to_hex(),
                    &state.relay_keypair,
                )
                .await
                .unwrap();
        } else {
            sqlx::query(
                "UPDATE relay_members SET updated_at=now()-interval '61 seconds' \
                 WHERE community_id=$1 AND pubkey=$2",
            )
            .bind(tenant.community().as_uuid())
            .bind(owner.public_key().to_hex())
            .execute(state.db.pool())
            .await
            .unwrap();
            let _ = state
                .db
                .update_relay_member_role(
                    tenant.community(),
                    &owner.public_key().to_hex(),
                    "member",
                    &state.relay_keypair,
                )
                .await
                .unwrap();
            enforce_sessions(&state, &policy).await;
            assert!(
                !root_cancel.is_cancelled(),
                "owner renewal keeps the agent alive"
            );
            assert!(
                !audio_cancel.is_cancelled(),
                "audio follows the same renewal"
            );
            sqlx::query(
                "UPDATE relay_members SET updated_at=now()-interval '61 seconds' \
                 WHERE community_id=$1 AND pubkey=$2",
            )
            .bind(tenant.community().as_uuid())
            .bind(owner.public_key().to_hex())
            .execute(state.db.pool())
            .await
            .unwrap();
        }
        tokio::time::timeout(Duration::from_secs(4), enforce_sessions(&state, &policy))
            .await
            .expect("owner revocation monitor is bounded");
        assert!(root_cancel.is_cancelled());
        assert!(audio_cancel.is_cancelled());
        state.conn_manager.deregister(root_id);
    }
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn stored_owner_metadata_cannot_renew_a_session_without_a_delegation_credential() {
    let controller = Keys::generate();
    let owner = Keys::generate();
    let agent = Keys::generate();
    let state = managed_state_with_agents(&controller, true).await;
    let tenant = community(&state, "managed-agent-unproven-owner").await;
    for key in [&owner, &agent] {
        let _ = state
            .db
            .add_relay_member(
                tenant.community(),
                &key.public_key().to_hex(),
                "member",
                Some(&controller.public_key().to_hex()),
                &state.relay_keypair,
            )
            .await
            .unwrap();
    }
    let control = CommunityConnectionControl::new(CancellationToken::new());
    control.bind_pubkey(agent.public_key().to_bytes());
    control.bind_owner(owner.public_key().to_bytes());
    let _registration =
        state
            .community_connections
            .register(Uuid::new_v4(), tenant.community(), control.clone());
    let policy = policy_with_agents(&controller, true);
    enforce_sessions(&state, &policy).await;
    assert!(!control.cancellation_token().is_cancelled());
    sqlx::query(
        "UPDATE relay_members SET updated_at=now()-interval '61 seconds' \
         WHERE community_id=$1 AND pubkey=$2",
    )
    .bind(tenant.community().as_uuid())
    .bind(agent.public_key().to_hex())
    .execute(state.db.pool())
    .await
    .unwrap();
    enforce_sessions(&state, &policy).await;
    assert!(
        control.cancellation_token().is_cancelled(),
        "stored ownership is for revocation, not evidence of session delegation",
    );
}
