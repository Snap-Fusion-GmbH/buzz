use super::{is_global_only_kind, required_scope_for_kind, requires_h_channel_scope};
use buzz_auth::Scope;
use buzz_core::kind::KIND_CHANNEL_MEETING;
use nostr::{Event, EventBuilder, Keys, Kind, Tag};
use serde_json::json;
use uuid::Uuid;

fn event(content: serde_json::Value, tags: Vec<Tag>) -> Event {
    EventBuilder::new(
        Kind::Custom(KIND_CHANNEL_MEETING as u16),
        content.to_string(),
    )
    .tags(tags)
    .sign_with_keys(&Keys::generate())
    .unwrap()
}

fn definition() -> serde_json::Value {
    json!({
        "version": 1,
        "title": "Weekly team sync",
        "starts_at": "2026-10-26T10:00:00",
        "timezone": "Europe/Berlin",
        "duration_minutes": 30,
        "recurrence": "weekly"
    })
}

fn tags() -> Vec<Tag> {
    let channel = Uuid::new_v4();
    let identifier = buzz_core::meeting::meeting_identifier(channel, Uuid::new_v4());
    vec![
        Tag::parse(["h", &channel.to_string()]).unwrap(),
        Tag::parse(["d", &identifier]).unwrap(),
    ]
}

#[test]
fn meeting_writes_require_a_channel_and_message_write_scope() {
    let event = event(definition(), tags());
    assert_eq!(
        required_scope_for_kind(KIND_CHANNEL_MEETING, &event),
        Ok(Scope::MessagesWrite)
    );
    assert!(requires_h_channel_scope(KIND_CHANNEL_MEETING));
    assert!(!is_global_only_kind(KIND_CHANNEL_MEETING));
}

#[test]
fn ingest_scope_resolution_rejects_invalid_meeting_bodies_and_channel_addresses() {
    let mut invalid = definition();
    invalid["timezone"] = "Invalid/Timezone".into();
    for event in [
        event(invalid, tags()),
        event(definition(), Vec::new()),
        event(
            definition(),
            vec![Tag::parse(["h", &Uuid::new_v4().to_string()]).unwrap()],
        ),
    ] {
        assert_eq!(
            required_scope_for_kind(KIND_CHANNEL_MEETING, &event),
            Err("invalid: malformed channel meeting")
        );
    }
}
