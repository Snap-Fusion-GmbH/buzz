//! Signed channel-meeting event builders.

use buzz_core::meeting::{meeting_identifier, MeetingDefinition, MAX_MEETING_CONTENT_BYTES};
use nostr::{EventBuilder, EventId, Kind, Tag};
use uuid::Uuid;

use crate::{kind::KIND_CHANNEL_MEETING, SdkError};

/// Build a create-only meeting-series head in a channel.
///
/// The organizer signs the result. The `d` tag includes the channel UUID so a
/// replacement cannot move an existing meeting into a different channel.
pub fn build_channel_meeting(
    channel_id: Uuid,
    meeting_id: Uuid,
    definition: &MeetingDefinition,
) -> Result<EventBuilder, SdkError> {
    build_meeting_with_revision(channel_id, meeting_id, definition, "none")
}

/// Build a revision-checked replacement of a meeting series.
pub fn build_channel_meeting_update(
    channel_id: Uuid,
    meeting_id: Uuid,
    definition: &MeetingDefinition,
    expected_revision: EventId,
) -> Result<EventBuilder, SdkError> {
    build_meeting_with_revision(
        channel_id,
        meeting_id,
        definition,
        &expected_revision.to_hex(),
    )
}

fn build_meeting_with_revision(
    channel_id: Uuid,
    meeting_id: Uuid,
    definition: &MeetingDefinition,
    expected_revision: &str,
) -> Result<EventBuilder, SdkError> {
    definition
        .validate()
        .map_err(|error| SdkError::InvalidInput(error.to_string()))?;
    let content = serde_json::to_string(definition)
        .map_err(|error| SdkError::InvalidInput(format!("invalid meeting definition: {error}")))?;
    if content.len() > MAX_MEETING_CONTENT_BYTES {
        return Err(SdkError::ContentTooLarge {
            max: MAX_MEETING_CONTENT_BYTES,
            got: content.len(),
        });
    }
    let channel = channel_id.to_string();
    let identifier = meeting_identifier(channel_id, meeting_id);
    let tags = [
        Tag::parse(["h", channel.as_str()])
            .map_err(|error| SdkError::InvalidTag(error.to_string()))?,
        Tag::parse(["d", identifier.as_str()])
            .map_err(|error| SdkError::InvalidTag(error.to_string()))?,
        Tag::parse(["expected-revision", expected_revision])
            .map_err(|error| SdkError::InvalidTag(error.to_string()))?,
    ];
    Ok(EventBuilder::new(Kind::Custom(KIND_CHANNEL_MEETING as u16), content).tags(tags))
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_core::meeting::{
        parse_channel_meeting, MeetingRecurrence, MeetingStatus, MEETING_VERSION,
    };
    use nostr::Keys;

    #[test]
    fn signed_active_and_cancelled_heads_keep_the_same_channel_bound_address() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let meeting = Uuid::new_v4();
        let mut definition = MeetingDefinition {
            version: MEETING_VERSION,
            title: "Weekly team sync".into(),
            starts_at: "2026-10-26T10:00:00".parse().unwrap(),
            timezone: "Europe/Berlin".into(),
            duration_minutes: 30,
            recurrence: MeetingRecurrence::Weekly,
            status: MeetingStatus::Active,
            nudge_minutes_before: None,
            skipped_dates: Vec::new(),
        };
        for status in [MeetingStatus::Active, MeetingStatus::Cancelled] {
            definition.status = status;
            let event = build_channel_meeting(channel, meeting, &definition)
                .unwrap()
                .sign_with_keys(&keys)
                .unwrap();
            event.verify().unwrap();
            let parsed = parse_channel_meeting(&event).unwrap();
            assert_eq!(parsed.channel_id, channel);
            assert_eq!(parsed.meeting_id, meeting);
            assert_eq!(parsed.definition, definition);
        }
        definition.title = " ".into();
        assert!(build_channel_meeting(channel, meeting, &definition).is_err());
    }

    #[test]
    fn create_and_update_builders_bind_distinct_revision_preconditions() {
        let keys = Keys::generate();
        let channel = Uuid::new_v4();
        let meeting = Uuid::new_v4();
        let definition: MeetingDefinition = serde_json::from_value(serde_json::json!({
            "version": 1, "title": "Sync", "starts_at": "2026-10-26T10:00:00",
            "timezone": "Europe/Berlin", "duration_minutes": 30,
        }))
        .unwrap();
        let first = build_channel_meeting(channel, meeting, &definition)
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(
            buzz_core::meeting::meeting_revision(&first).unwrap(),
            buzz_core::meeting::MeetingRevision::NoHead
        );
        let update = build_channel_meeting_update(channel, meeting, &definition, first.id)
            .unwrap()
            .sign_with_keys(&keys)
            .unwrap();
        assert_eq!(
            buzz_core::meeting::meeting_revision(&update).unwrap(),
            buzz_core::meeting::MeetingRevision::Head(first.id)
        );
    }
}
