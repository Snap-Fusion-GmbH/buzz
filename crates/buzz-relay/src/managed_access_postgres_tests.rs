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
    let owner = controller.public_key().to_hex();
    ManagedAccessPolicy::parse(
        &serde_json::json!({
            "controller_pubkey": owner,
            "membership_ttl_seconds": 60,
        })
        .to_string(),
        true,
        false,
        Some(&owner),
    )
    .unwrap()
}

async fn managed_state(controller: &Keys) -> Arc<AppState> {
    let raw = state().await;
    let mut raw = Arc::try_unwrap(raw).unwrap_or_else(|arc| (*arc).clone());
    let mut config = (*raw.config).clone();
    config.require_relay_membership = true;
    config.relay_owner_pubkey = Some(controller.public_key().to_hex());
    config.managed_access = Some(policy(controller));
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
    state
        .db
        .add_relay_member(
            tenant.community(),
            &member.public_key().to_hex(),
            "member",
            Some(&controller.public_key().to_hex()),
        )
        .await
        .unwrap();
    let member_bytes = member.public_key().to_bytes();
    let decision = || check_relay_membership(&state, tenant.community(), &member_bytes, None, None);
    assert_eq!(decision().await.unwrap(), MembershipDecision::Member);
    let invitee = Keys::generate();
    state
        .db
        .add_relay_member(
            tenant.community(),
            &invitee.public_key().to_hex(),
            "member",
            Some("invite"),
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
    state
        .db
        .add_relay_member(
            tenant.community(),
            &member.public_key().to_hex(),
            "member",
            Some(&controller.public_key().to_hex()),
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
