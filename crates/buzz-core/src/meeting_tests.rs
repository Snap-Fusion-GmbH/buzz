use super::*;
use nostr::{EventBuilder, Keys, Kind, Tag};

fn definition(starts_at: &str, recurrence: MeetingRecurrence) -> MeetingDefinition {
    MeetingDefinition {
        version: MEETING_VERSION,
        title: "Weekly team sync".into(),
        starts_at: starts_at.parse().unwrap(),
        timezone: "Europe/Berlin".into(),
        duration_minutes: 30,
        recurrence,
        status: MeetingStatus::Active,
        nudge_minutes_before: None,
        skipped_dates: Vec::new(),
    }
}

fn utc(value: &str) -> DateTime<Utc> {
    value.parse().unwrap()
}

#[test]
fn weekly_meetings_keep_local_time_across_both_dst_transitions() {
    for (first_start, after, expected) in [
        (
            "2026-03-23T10:00:00",
            "2026-03-23T00:00:00Z",
            ["2026-03-23T09:00:00Z", "2026-03-30T08:00:00Z"],
        ),
        (
            "2026-10-19T10:00:00",
            "2026-10-19T00:00:00Z",
            ["2026-10-19T08:00:00Z", "2026-10-26T09:00:00Z"],
        ),
    ] {
        let meeting = definition(first_start, MeetingRecurrence::Weekly);
        let occurrences = meeting.next_occurrences(utc(after), 2).unwrap();
        assert_eq!(
            occurrences
                .iter()
                .map(|occurrence| occurrence.starts_at)
                .collect::<Vec<_>>(),
            expected.map(utc)
        );
        for occurrence in occurrences {
            assert_eq!(
                occurrence.ends_at - occurrence.starts_at,
                Duration::minutes(30)
            );
        }
    }
}

#[test]
fn nonexistent_first_start_is_rejected_and_future_gap_is_skipped() {
    assert!(definition("2026-03-29T02:30:00", MeetingRecurrence::Weekly)
        .validate()
        .is_err());
    let meeting = definition("2026-03-22T02:30:00", MeetingRecurrence::Weekly);
    let occurrences = meeting
        .next_occurrences(utc("2026-03-22T00:00:00Z"), 2)
        .unwrap();
    assert_eq!(occurrences[0].local_date.to_string(), "2026-03-22");
    assert_eq!(occurrences[1].local_date.to_string(), "2026-04-05");
}

#[test]
fn ambiguous_local_start_fires_only_at_the_earlier_instant() {
    let meeting = definition("2026-10-25T02:30:00", MeetingRecurrence::Weekly);
    let occurrences = meeting
        .next_occurrences(utc("2026-10-25T00:00:00Z"), 2)
        .unwrap();
    assert_eq!(occurrences[0].starts_at, utc("2026-10-25T00:30:00Z"));
    assert_eq!(occurrences[1].local_date.to_string(), "2026-11-01");
    let after_first = meeting
        .next_occurrences(utc("2026-10-25T01:00:00Z"), 1)
        .unwrap();
    assert_eq!(after_first[0].local_date.to_string(), "2026-11-01");
}

#[test]
fn skipped_dates_do_not_shift_the_recurrence_anchor() {
    let mut meeting = definition("2026-10-26T10:00:00", MeetingRecurrence::Fortnightly);
    meeting.skipped_dates.push("2026-11-09".parse().unwrap());
    let occurrences = meeting
        .next_occurrences(utc("2026-10-26T00:00:00Z"), 3)
        .unwrap();
    assert_eq!(
        occurrences
            .iter()
            .map(|occurrence| occurrence.local_date.to_string())
            .collect::<Vec<_>>(),
        ["2026-10-26", "2026-11-23", "2026-12-07"]
    );
}

#[test]
fn weekday_meetings_skip_weekends_and_can_start_years_before_the_query() {
    let meeting = definition("2020-01-01T10:00:00", MeetingRecurrence::Weekdays);
    let occurrences = meeting
        .next_occurrences(utc("2026-10-23T00:00:00Z"), 2)
        .unwrap();
    assert_eq!(occurrences[0].local_date.to_string(), "2026-10-23");
    assert_eq!(occurrences[1].local_date.to_string(), "2026-10-26");
    assert!(
        definition("2026-10-25T10:00:00", MeetingRecurrence::Weekdays)
            .validate()
            .is_err()
    );
}

#[test]
fn one_time_and_cancelled_meetings_do_not_generate_extra_occurrences() {
    let mut meeting = definition("2026-10-26T10:00:00", MeetingRecurrence::Once);
    assert_eq!(
        meeting
            .next_occurrences(utc("2026-10-26T09:00:00Z"), 3)
            .unwrap()
            .len(),
        1
    );
    assert!(meeting
        .next_occurrences(utc("2026-10-26T09:00:01Z"), 3)
        .unwrap()
        .is_empty());
    meeting.status = MeetingStatus::Cancelled;
    assert!(meeting
        .next_occurrences(utc("2026-10-20T00:00:00Z"), 3)
        .unwrap()
        .is_empty());
}

#[test]
fn nudges_are_opt_in_and_use_elapsed_minutes_before_the_start() {
    let mut meeting = definition("2026-10-26T10:00:00", MeetingRecurrence::Weekly);
    assert_eq!(
        meeting
            .next_occurrences(utc("2026-10-26T00:00:00Z"), 1)
            .unwrap()[0]
            .nudge_at,
        None
    );
    meeting.nudge_minutes_before = Some(15);
    assert_eq!(
        meeting
            .next_occurrences(utc("2026-10-26T00:00:00Z"), 1)
            .unwrap()[0]
            .nudge_at,
        Some(utc("2026-10-26T08:45:00Z"))
    );
}

#[test]
fn validation_rejects_invalid_limits_and_unsupported_values() {
    let valid = definition("2026-10-26T10:00:00", MeetingRecurrence::Weekly);
    let mut invalid = valid.clone();
    for title in [
        "".to_string(),
        " ".into(),
        "x".repeat(MAX_MEETING_TITLE_BYTES + 1),
        "bad\nname".into(),
    ] {
        invalid.title = title;
        assert!(invalid.validate().is_err());
    }
    for duration in [0, 1441] {
        invalid = valid.clone();
        invalid.duration_minutes = duration;
        assert!(invalid.validate().is_err());
    }
    for lead in [0, 1441] {
        invalid = valid.clone();
        invalid.nudge_minutes_before = Some(lead);
        assert!(invalid.validate().is_err());
    }
    invalid = valid.clone();
    invalid.timezone = "Not/AZone".into();
    assert!(invalid.validate().is_err());
    invalid = valid.clone();
    invalid.version = 2;
    assert!(invalid.validate().is_err());
    invalid = valid.clone();
    invalid.starts_at = "2026-10-26T10:00:01".parse().unwrap();
    assert!(invalid.validate().is_err());
    for limit in [0, MAX_MEETING_OCCURRENCES + 1] {
        assert!(valid
            .next_occurrences(utc("2026-10-26T00:00:00Z"), limit)
            .is_err());
    }
}

#[test]
fn skipped_dates_must_be_bounded_distinct_and_match_the_series() {
    let mut meeting = definition("2026-10-26T10:00:00", MeetingRecurrence::Weekly);
    for dates in [
        vec!["2026-10-19"],
        vec!["2026-10-27"],
        vec!["2026-11-02", "2026-11-02"],
    ] {
        meeting.skipped_dates = dates
            .into_iter()
            .map(|date| date.parse().unwrap())
            .collect();
        assert!(meeting.validate().is_err());
    }
    meeting.skipped_dates = vec!["2026-11-02".parse().unwrap(); MAX_MEETING_SKIPPED_DATES + 1];
    assert!(meeting.validate().is_err());
}

fn event_with_tags(tags: Vec<Tag>, content: String) -> Event {
    EventBuilder::new(Kind::Custom(KIND_CHANNEL_MEETING as u16), content)
        .tags(tags)
        .sign_with_keys(&Keys::generate())
        .unwrap()
}

#[test]
fn envelope_binds_one_canonical_channel_to_one_meeting_address() {
    let channel_id = Uuid::new_v4();
    let meeting_id = Uuid::new_v4();
    let meeting = definition("2026-10-26T10:00:00", MeetingRecurrence::Weekly);
    let content = serde_json::to_string(&meeting).unwrap();
    let identifier = meeting_identifier(channel_id, meeting_id);
    let channel_tag = Tag::parse(["h", &channel_id.to_string()]).unwrap();
    let address_tag = Tag::parse(["d", &identifier]).unwrap();
    let event = event_with_tags(
        vec![channel_tag.clone(), address_tag.clone()],
        content.clone(),
    );
    let parsed = parse_channel_meeting(&event).unwrap();
    assert_eq!(parsed.channel_id, channel_id);
    assert_eq!(parsed.meeting_id, meeting_id);
    assert_eq!(parsed.definition, meeting);
    for tags in [
        vec![address_tag.clone()],
        vec![channel_tag.clone()],
        vec![
            channel_tag.clone(),
            address_tag.clone(),
            Tag::parse(["h", &Uuid::new_v4().to_string()]).unwrap(),
        ],
        vec![
            channel_tag.clone(),
            address_tag.clone(),
            Tag::parse(["d", "another"]).unwrap(),
        ],
        vec![
            channel_tag.clone(),
            Tag::parse(["d", &meeting_identifier(Uuid::new_v4(), meeting_id)]).unwrap(),
        ],
        vec![
            channel_tag.clone(),
            Tag::parse(["d", &meeting_id.to_string()]).unwrap(),
        ],
        vec![channel_tag, address_tag, Tag::parse(["h"]).unwrap()],
    ] {
        assert!(parse_channel_meeting(&event_with_tags(tags, content.clone())).is_err());
    }
}

#[test]
fn unknown_fields_removed_from_the_design_are_not_silently_accepted() {
    for field in ["location", "preparation_note"] {
        let mut content =
            serde_json::to_value(definition("2026-10-26T10:00:00", MeetingRecurrence::Weekly))
                .unwrap();
        content[field] = "unsupported".into();
        assert!(serde_json::from_value::<MeetingDefinition>(content).is_err());
    }
}

#[test]
fn envelope_rejects_wrong_kinds_oversized_bodies_and_noncanonical_addresses() {
    let channel_id = Uuid::parse_str("abcdef01-2345-4678-9abc-def012345678").unwrap();
    let meeting_id = Uuid::new_v4();
    let content = serde_json::to_string(&definition(
        "2026-10-26T10:00:00",
        MeetingRecurrence::Weekly,
    ))
    .unwrap();
    let tags = vec![
        Tag::parse(["h", &channel_id.to_string()]).unwrap(),
        Tag::parse(["d", &meeting_identifier(channel_id, meeting_id)]).unwrap(),
    ];
    let wrong_kind = EventBuilder::new(Kind::Custom(9), content.clone())
        .tags(tags.clone())
        .sign_with_keys(&Keys::generate())
        .unwrap();
    assert!(parse_channel_meeting(&wrong_kind).is_err());
    let oversized = event_with_tags(
        tags,
        format!("{}{}", " ".repeat(MAX_MEETING_CONTENT_BYTES), content),
    );
    assert!(parse_channel_meeting(&oversized).is_err());
    let upper_channel = channel_id.to_string().to_uppercase();
    let noncanonical = event_with_tags(
        vec![
            Tag::parse(["h", &upper_channel]).unwrap(),
            Tag::parse(["d", &format!("{upper_channel}:{meeting_id}")]).unwrap(),
        ],
        content,
    );
    assert!(parse_channel_meeting(&noncanonical).is_err());
}

#[test]
fn duration_stays_elapsed_time_when_the_meeting_crosses_a_dst_boundary() {
    let mut meeting = definition("2026-03-29T01:30:00", MeetingRecurrence::Once);
    meeting.duration_minutes = 120;
    let occurrence = meeting
        .next_occurrences(utc("2026-03-29T00:00:00Z"), 1)
        .unwrap()
        .remove(0);
    assert_eq!(occurrence.starts_at, utc("2026-03-29T00:30:00Z"));
    assert_eq!(occurrence.ends_at, utc("2026-03-29T02:30:00Z"));
}
