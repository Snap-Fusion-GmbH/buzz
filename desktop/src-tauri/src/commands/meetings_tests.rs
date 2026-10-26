use super::*;
use buzz_core_pkg::meeting::{MeetingRecurrence, MEETING_VERSION};

#[test]
fn meeting_support_requires_an_explicit_protocol_advertisement() {
    for (document, supported) in [
        (serde_json::json!({}), false),
        (
            serde_json::json!({"supported_extensions": ["nip-er"]}),
            false,
        ),
        (
            serde_json::json!({"supported_extensions": ["nip-cm-other"]}),
            false,
        ),
        (
            serde_json::json!({"supported_extensions": ["nip-cm"]}),
            true,
        ),
    ] {
        let info: MeetingRelayInformation = serde_json::from_value(document).unwrap();
        assert_eq!(info.supports_meetings(), supported);
    }
}

fn scope(keys: &Keys) -> MeetingScopeInput {
    MeetingScopeInput {
        channel_id: "abcdef01-2345-4678-9abc-def012345678".into(),
        expected_relay_url: "wss://community-a.example".into(),
        expected_signer_pubkey: keys.public_key().to_hex(),
    }
}

fn definition() -> MeetingDefinition {
    MeetingDefinition {
        version: MEETING_VERSION,
        title: "Weekly team sync".into(),
        starts_at: "2099-10-26T10:00:00".parse().unwrap(),
        timezone: "Europe/Berlin".into(),
        duration_minutes: 30,
        recurrence: MeetingRecurrence::Weekly,
        status: MeetingStatus::Active,
        nudge_minutes_before: None,
        skipped_dates: Vec::new(),
    }
}

#[test]
fn meeting_scope_binds_one_expected_relay_and_identity_and_rejects_missing_fences() {
    let keys = Keys::generate();
    let input = scope(&keys);
    let bound = input
        .bind("https://community-a.example".into(), keys.clone())
        .unwrap();
    assert_eq!(bound.api_base, "https://community-a.example");
    assert_eq!(bound.keys.public_key(), keys.public_key());
    assert!(input
        .bind("https://community-b.example".into(), keys.clone())
        .is_err());
    assert!(input
        .bind("https://community-a.example".into(), Keys::generate())
        .is_err());
    for field in ["relay", "signer"] {
        let mut missing = input.clone();
        if field == "relay" {
            missing.expected_relay_url.clear();
        } else {
            missing.expected_signer_pubkey.clear();
        }
        assert!(missing
            .bind("https://community-a.example".into(), keys.clone())
            .is_err());
    }
}

#[test]
fn meeting_wire_preserves_verified_head_ownership_and_occurrence_metadata() {
    let keys = Keys::generate();
    let session = scope(&keys)
        .bind("https://community-a.example".into(), keys.clone())
        .unwrap();
    let meeting_id = Uuid::new_v4();
    let event = buzz_sdk_pkg::build_channel_meeting(session.channel, meeting_id, &definition())
        .unwrap()
        .sign_with_keys(&keys)
        .unwrap();
    let wire = meeting_wire(&event, &session).unwrap();
    assert_eq!(wire.id, meeting_id.to_string());
    assert_eq!(wire.revision, event.id.to_hex());
    assert_eq!(wire.organizer_pubkey, keys.public_key().to_hex());
    assert!(wire.can_manage);
    assert_eq!(wire.occurrences.len(), 3);
    assert_eq!(wire.definition, definition());
    let other = Keys::generate();
    let foreign =
        buzz_sdk_pkg::build_channel_meeting(session.channel, Uuid::new_v4(), &definition())
            .unwrap()
            .sign_with_keys(&other)
            .unwrap();
    assert!(!meeting_wire(&foreign, &session).unwrap().can_manage);
}

#[test]
fn meeting_wire_rejects_foreign_channels_and_tampered_signed_content() {
    let keys = Keys::generate();
    let session = scope(&keys)
        .bind("https://community-a.example".into(), keys.clone())
        .unwrap();
    let foreign =
        buzz_sdk_pkg::build_channel_meeting(Uuid::new_v4(), Uuid::new_v4(), &definition())
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
    assert!(meeting_wire(&foreign, &session).is_err());
    let event = buzz_sdk_pkg::build_channel_meeting(session.channel, Uuid::new_v4(), &definition())
        .unwrap()
        .sign_with_keys(&keys)
        .unwrap();
    let mut tampered = serde_json::to_value(&event).unwrap();
    let mut changed = definition();
    changed.title = "Tampered meeting".into();
    tampered["content"] = serde_json::to_string(&changed).unwrap().into();
    let tampered: Event = serde_json::from_value(tampered).unwrap();
    assert!(meeting_wire(&tampered, &session).is_err());
}

#[test]
fn meeting_revision_preflight_is_falsifiable_and_cancelled_previews_are_empty() {
    let keys = Keys::generate();
    let session = scope(&keys)
        .bind("https://community-a.example".into(), keys.clone())
        .unwrap();
    let mut cancelled = definition();
    cancelled.status = MeetingStatus::Cancelled;
    let event = buzz_sdk_pkg::build_channel_meeting(session.channel, Uuid::new_v4(), &cancelled)
        .unwrap()
        .sign_with_keys(&keys)
        .unwrap();
    assert!(require_revision(&event, &event.id.to_hex()).is_ok());
    assert!(require_revision(&event, &"0".repeat(64)).is_err());
    assert!(require_revision(&event, "not-a-revision").is_err());
    assert!(meeting_wire(&event, &session)
        .unwrap()
        .occurrences
        .is_empty());
}
