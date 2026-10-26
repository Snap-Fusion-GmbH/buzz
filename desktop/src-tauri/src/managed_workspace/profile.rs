use nostr::{EventBuilder, Keys};

use crate::{
    app_state::AppState,
    relay::{query_relay_at_with_keys, relay_http_base_url, submit_event_at_with_keys},
};

use super::WorkspaceProfile;

fn first_profile(
    has_profile: bool,
    display_name: Option<&str>,
) -> Result<Option<EventBuilder>, String> {
    if has_profile {
        return Ok(None);
    }
    let name = display_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("R&D member");
    if name.chars().count() > 256 || name.chars().any(char::is_control) {
        return Err("Work-account profile name is invalid".into());
    }
    crate::events::build_profile(Some(name), None, None, None, None).map(Some)
}

pub(super) async fn ensure_profile(
    state: &AppState,
    keys: &Keys,
    profile: &WorkspaceProfile,
) -> Result<(), String> {
    let api_base = relay_http_base_url(&profile.relay_url);
    let filter = serde_json::json!({
        "kinds": [0], "authors": [keys.public_key().to_hex()], "limit": 1
    });
    let existing = query_relay_at_with_keys(state, &api_base, &[filter], keys, None).await?;
    if let Some(builder) = first_profile(!existing.is_empty(), profile.display_name.as_deref())? {
        submit_event_at_with_keys(builder, state, &api_base, keys).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::first_profile;

    #[test]
    fn existing_profiles_are_never_replaced_by_directory_names() {
        assert!(first_profile(true, Some("New directory name"))
            .unwrap()
            .is_none());
        assert!(first_profile(true, Some("\n")).unwrap().is_none());
    }

    #[test]
    fn first_profile_uses_only_the_work_account_name() {
        let keys = nostr::Keys::generate();
        let event = first_profile(false, Some("  Fixture Person  "))
            .unwrap()
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(event.pubkey, keys.public_key());
        assert_eq!(event.kind, nostr::Kind::Metadata);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&event.content).unwrap(),
            serde_json::json!({"display_name": "Fixture Person"})
        );
    }

    #[test]
    fn invalid_work_names_cannot_become_profile_content() {
        assert!(first_profile(false, Some("Fixture\nPerson")).is_err());
        assert!(first_profile(false, Some(&"a".repeat(257))).is_err());
        assert!(first_profile(false, None).unwrap().is_some());
    }
}
