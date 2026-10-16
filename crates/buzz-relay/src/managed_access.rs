//! Opt-in Entra-managed workspace membership freshness and channel authority.

use std::{sync::Arc, time::Duration};

use buzz_db::relay_members::RelayMember;
use chrono::{DateTime, Utc};
use futures_util::{stream, StreamExt};
use nostr::PublicKey;
use serde::Deserialize;
use tokio::task::JoinHandle;

use crate::{config::ConfigError, state::AppState};

const CHECK_INTERVAL: Duration = Duration::from_secs(5);
pub(crate) const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyInput {
    controller_pubkey: String,
    membership_ttl_seconds: u64,
}

/// Explicit deployment policy for a controller-owned, directory-managed relay.
#[derive(Clone, Debug)]
pub struct ManagedAccessPolicy {
    controller: PublicKey,
    ttl: Duration,
}

impl ManagedAccessPolicy {
    /// Validate an opt-in policy against the relay's existing admission settings.
    pub fn parse(
        raw: &str,
        require_membership: bool,
        allow_owner_delegation: bool,
        configured_owner: Option<&str>,
    ) -> Result<Self, ConfigError> {
        let input: PolicyInput = serde_json::from_str(raw)
            .map_err(|_| ConfigError::InvalidValue("BUZZ_MANAGED_ACCESS is invalid".into()))?;
        let controller = PublicKey::from_hex(&input.controller_pubkey).map_err(|_| {
            ConfigError::InvalidValue("BUZZ_MANAGED_ACCESS controller is invalid".into())
        })?;
        if input.controller_pubkey != controller.to_hex()
            || configured_owner != Some(input.controller_pubkey.as_str())
            || !require_membership
            || allow_owner_delegation
            || !(30..=300).contains(&input.membership_ttl_seconds)
        {
            return Err(ConfigError::InvalidValue(
                "BUZZ_MANAGED_ACCESS requires a matching owner, closed membership, \
                 no owner delegation, and a TTL between 30 and 300 seconds"
                    .into(),
            ));
        }
        Ok(Self {
            controller,
            ttl: Duration::from_secs(input.membership_ttl_seconds),
        })
    }

    /// Read the optional managed policy. Ordinary relays retain existing behavior.
    pub fn from_env(
        require_membership: bool,
        allow_owner_delegation: bool,
        configured_owner: Option<&str>,
    ) -> Result<Option<Self>, ConfigError> {
        match std::env::var("BUZZ_MANAGED_ACCESS") {
            Ok(raw) => Self::parse(
                &raw,
                require_membership,
                allow_owner_delegation,
                configured_owner,
            )
            .map(Some),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(_) => Err(ConfigError::InvalidValue(
                "BUZZ_MANAGED_ACCESS is not valid UTF-8".into(),
            )),
        }
    }

    /// Whether a channel was created by the directory controller.
    pub fn controls_channel(&self, creator: &[u8]) -> bool {
        creator == self.controller.as_bytes()
    }

    /// Whether an actor is the deployment's pinned directory controller.
    pub fn is_controller(&self, actor: &[u8]) -> bool {
        actor == self.controller.as_bytes()
    }

    /// Evaluate the writer's current membership record, including exact expiry.
    pub fn admits(&self, member: &RelayMember, now: DateTime<Utc>) -> bool {
        if member.pubkey == self.controller.to_hex() {
            return member.role == "owner";
        }
        if !matches!(member.role.as_str(), "member" | "admin") {
            return false;
        }
        if member.added_by.as_deref() != Some(self.controller.to_hex().as_str()) {
            return false;
        }
        let age = now.signed_duration_since(member.updated_at);
        age.to_std().is_ok_and(|age| age < self.ttl)
    }
}

/// Start the bounded live-session backstop for an explicitly managed deployment.
///
/// HTTP admission independently reads the same lease from the writer. Each pod
/// monitors its own root and audio sockets, so this does not depend on a
/// controller process, a Redis disconnect delivery, or another replica.
pub fn spawn_monitor(state: &Arc<AppState>) -> Option<JoinHandle<()>> {
    let policy = state.config.managed_access.clone()?;
    let state = Arc::downgrade(state);
    Some(tokio::spawn(async move {
        let mut interval = tokio::time::interval(CHECK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let Some(state) = state.upgrade() else {
                break;
            };
            if state
                .shutting_down
                .load(std::sync::atomic::Ordering::Acquire)
            {
                break;
            }
            enforce_sessions(&state, &policy).await;
        }
    }))
}

pub(crate) async fn enforce_sessions(state: &Arc<AppState>, policy: &ManagedAccessPolicy) {
    let sessions = state.managed_connection_subjects();
    let checks = stream::iter(sessions.iter()).for_each_concurrent(
        8,
        |(community, key, control)| async move {
            let admitted = state
                .db
                .get_relay_member_with_clock(*community, &hex::encode(key))
                .await
                .ok()
                .flatten()
                .is_some_and(|(record, now)| policy.admits(&record, now));
            if !admitted {
                control.revoke_access();
            }
        },
    );
    // One deadline covers the whole sweep, including pool acquisition. If it
    // cannot finish, no unverified session is retained until a later sweep.
    if tokio::time::timeout(LOOKUP_TIMEOUT, checks).await.is_err() {
        for (_, _, control) in sessions {
            control.revoke_access();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> ManagedAccessPolicy {
        let owner =
            PublicKey::from_hex("e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34")
                .unwrap();
        ManagedAccessPolicy::parse(
            &serde_json::json!({
                "controller_pubkey": owner.to_hex(),
                "membership_ttl_seconds": 60
            })
            .to_string(),
            true,
            false,
            Some(&owner.to_hex()),
        )
        .unwrap()
    }

    #[test]
    fn exact_expiry_and_future_timestamps_do_not_authorize() {
        let now = Utc::now();
        let mut member = RelayMember {
            pubkey: "b".repeat(64),
            role: "member".into(),
            added_by: Some(policy().controller.to_hex()),
            created_at: now,
            updated_at: now,
        };
        assert!(policy().admits(&member, now));
        assert!(policy().admits(&member, now + chrono::Duration::seconds(59)));
        assert!(!policy().admits(&member, now + chrono::Duration::seconds(60)));
        member.updated_at = now + chrono::Duration::seconds(1);
        assert!(!policy().admits(&member, now));
        member.role = "owner".into();
        assert!(!policy().admits(&member, now));
    }

    #[test]
    fn fresh_invite_or_member_added_rows_are_not_directory_enrollment() {
        let now = Utc::now();
        let mut member = RelayMember {
            pubkey: "b".repeat(64),
            role: "member".into(),
            added_by: None,
            created_at: now,
            updated_at: now,
        };
        for origin in [None, Some("invite".into()), Some("b".repeat(64))] {
            member.added_by = origin;
            assert!(!policy().admits(&member, now));
        }
        member.added_by = Some(policy().controller.to_hex());
        assert!(policy().admits(&member, now));
    }

    #[test]
    fn only_the_pinned_controller_has_a_permanent_owner_membership() {
        let now = Utc::now();
        let mut member = RelayMember {
            pubkey: policy().controller.to_hex(),
            role: "owner".into(),
            added_by: None,
            created_at: now,
            updated_at: now - chrono::Duration::days(30),
        };
        assert!(policy().admits(&member, now));
        member.role = "member".into();
        assert!(!policy().admits(&member, now));
    }

    #[test]
    fn managed_configuration_cannot_enable_delegation_or_open_membership() {
        let valid = serde_json::json!({
            "controller_pubkey": policy().controller.to_hex(),
            "membership_ttl_seconds": 60
        });
        for (required, delegated, owner) in [
            (false, false, Some(policy().controller.to_hex())),
            (true, true, Some(policy().controller.to_hex())),
            (true, false, None),
        ] {
            assert!(ManagedAccessPolicy::parse(
                &valid.to_string(),
                required,
                delegated,
                owner.as_deref()
            )
            .is_err());
        }
        let mut invalid = valid;
        invalid["membership_ttl_seconds"] = serde_json::json!(0);
        assert!(ManagedAccessPolicy::parse(
            &invalid.to_string(),
            true,
            false,
            Some(&policy().controller.to_hex())
        )
        .is_err());
    }
}
