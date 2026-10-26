use super::*;
use axum::{routing::post, Json, Router};
use nostr::Keys;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Requests {
    queries: Arc<Mutex<Vec<Value>>>,
    writes: Arc<Mutex<Vec<Event>>>,
}

async fn fixture(
    response: impl FnOnce(&Keys) -> Vec<Event>,
    write_message: &'static str,
) -> (BuzzClient, Requests, tokio::task::JoinHandle<()>) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let keys = Keys::generate();
    let events = response(&keys);
    let requests = Requests::default();
    let query_requests = requests.clone();
    let write_requests = requests.clone();
    let router = Router::new()
        .route(
            "/query",
            post(move |Json(filter): Json<Value>| {
                let requests = query_requests.clone();
                let events = events.clone();
                async move {
                    requests.queries.lock().unwrap().push(filter);
                    Json(events)
                }
            }),
        )
        .route(
            "/events",
            post(move |Json(event): Json<Event>| {
                let requests = write_requests.clone();
                async move {
                    requests.writes.lock().unwrap().push(event.clone());
                    Json(json!({
                        "event_id": event.id.to_hex(),
                        "accepted": true,
                        "message": write_message,
                    }))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = BuzzClient::new(format!("http://{address}"), keys, None, None).unwrap();
    (client, requests, server)
}

fn definition() -> MeetingDefinition {
    MeetingDefinition {
        version: MEETING_VERSION,
        title: "Weekly team sync".into(),
        starts_at: "2026-10-26T10:00:00".parse().unwrap(),
        timezone: "Europe/Berlin".into(),
        duration_minutes: 30,
        recurrence: MeetingRecurrence::Weekly,
        status: MeetingStatus::Active,
        nudge_minutes_before: None,
        skipped_dates: Vec::new(),
    }
}

fn meeting_event(keys: &Keys, channel: Uuid, meeting: Uuid) -> Event {
    buzz_sdk::build_channel_meeting(channel, meeting, &definition())
        .unwrap()
        .sign_with_keys(keys)
        .unwrap()
}

#[tokio::test]
async fn create_publishes_one_signed_channel_bound_snapshot_with_nudges_off() {
    let (client, requests, server) = fixture(|_| vec![], "").await;
    let channel = Uuid::new_v4();
    dispatch(
        MeetingsCmd::Create {
            channel,
            title: " Weekly team sync ".into(),
            starts_at: definition().starts_at,
            timezone: "Europe/Berlin".into(),
            duration: 30,
            repeat: "weekly".into(),
        },
        &client,
        &OutputFormat::Json,
    )
    .await
    .unwrap();
    server.abort();
    assert!(requests.queries.lock().unwrap().is_empty());
    let writes = requests.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    writes[0].verify().unwrap();
    let parsed = parse_channel_meeting(&writes[0]).unwrap();
    assert_eq!(parsed.channel_id, channel);
    assert_eq!(parsed.definition, definition());
    assert_eq!(writes[0].pubkey, client.keys().public_key());
}

#[tokio::test]
async fn list_requests_explicit_channel_scoped_kinds_and_a_bounded_page() {
    let channel = Uuid::new_v4();
    let (client, requests, server) = fixture(
        |keys| vec![meeting_event(keys, channel, Uuid::new_v4())],
        "",
    )
    .await;
    dispatch(
        MeetingsCmd::List { channel, limit: 7 },
        &client,
        &OutputFormat::Json,
    )
    .await
    .unwrap();
    server.abort();
    let queries = requests.queries.lock().unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0][0]["kinds"], json!([KIND_CHANNEL_MEETING]));
    assert_eq!(queries[0][0]["#h"], json!([channel.to_string()]));
    assert_eq!(queries[0][0]["limit"], 7);
}

#[tokio::test]
async fn cancel_strong_reads_the_signers_head_and_publishes_a_newer_cancelled_snapshot() {
    let channel = Uuid::new_v4();
    let meeting = Uuid::new_v4();
    let head_timestamp = Timestamp::now().as_secs() + 60;
    let (client, requests, server) = fixture(
        |keys| {
            vec![
                buzz_sdk::build_channel_meeting(channel, meeting, &definition())
                    .unwrap()
                    .custom_created_at(Timestamp::from(head_timestamp))
                    .sign_with_keys(keys)
                    .unwrap(),
            ]
        },
        "",
    )
    .await;
    cancel_meeting(&client, channel, meeting).await.unwrap();
    server.abort();
    let queries = requests.queries.lock().unwrap();
    assert_eq!(queries[0][0]["consistency"], "strong");
    assert_eq!(
        queries[0][0]["authors"],
        json!([client.keys().public_key().to_hex()])
    );
    assert_eq!(queries[0][0]["#h"], json!([channel.to_string()]));
    assert_eq!(
        queries[0][0]["#d"],
        json!([meeting_identifier(channel, meeting)])
    );
    let writes = requests.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].created_at.as_secs(), head_timestamp + 1);
    let parsed = parse_channel_meeting(&writes[0]).unwrap();
    assert_eq!(parsed.meeting_id, meeting);
    assert_eq!(parsed.definition.status, MeetingStatus::Cancelled);
    assert_eq!(parsed.definition.title, definition().title);
    assert!(parsed
        .definition
        .next_occurrences(Utc::now(), 1)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn cancel_rejects_a_foreign_organizer_returned_by_a_bad_relay() {
    let channel = Uuid::new_v4();
    let meeting = Uuid::new_v4();
    let (client, requests, server) = fixture(
        |_| vec![meeting_event(&Keys::generate(), channel, meeting)],
        "",
    )
    .await;
    let error = cancel_meeting(&client, channel, meeting).await.unwrap_err();
    server.abort();
    assert!(error.to_string().contains("outside the requested"));
    assert!(requests.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn create_rejects_invalid_timezones_before_any_request() {
    let (client, requests, server) = fixture(|_| vec![], "").await;
    let error = dispatch(
        MeetingsCmd::Create {
            channel: Uuid::new_v4(),
            title: "Weekly sync".into(),
            starts_at: definition().starts_at,
            timezone: "Invalid/Timezone".into(),
            duration: 30,
            repeat: "weekly".into(),
        },
        &client,
        &OutputFormat::Json,
    )
    .await
    .unwrap_err();
    server.abort();
    assert!(matches!(error, CliError::Usage(_)));
    assert!(requests.queries.lock().unwrap().is_empty());
    assert!(requests.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn cancellation_that_loses_replacement_order_is_a_conflict_not_success() {
    let channel = Uuid::new_v4();
    let meeting = Uuid::new_v4();
    let (client, _, server) = fixture(
        |keys| vec![meeting_event(keys, channel, meeting)],
        "duplicate: newer event exists",
    )
    .await;
    let error = cancel_meeting(&client, channel, meeting).await.unwrap_err();
    server.abort();
    assert!(matches!(error, CliError::Conflict(_)));
}

#[tokio::test]
async fn update_publishes_the_complete_definition_with_the_observed_revision() {
    let channel = Uuid::new_v4();
    let meeting = Uuid::new_v4();
    let (client, requests, server) =
        fixture(|keys| vec![meeting_event(keys, channel, meeting)], "").await;
    let head = fetch_meeting(&client, channel, meeting, None, true)
        .await
        .unwrap();
    let mut updated = definition();
    updated.title = "Weekly priorities".into();
    updated.duration_minutes = 45;
    dispatch(
        MeetingsCmd::Update {
            channel,
            meeting,
            expected_revision: head.id,
            definition: serde_json::to_string(&updated).unwrap(),
        },
        &client,
        &OutputFormat::Json,
    )
    .await
    .unwrap();
    server.abort();
    let writes = requests.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    writes[0].verify().unwrap();
    assert_eq!(
        parse_channel_meeting(&writes[0]).unwrap().definition,
        updated
    );
    assert!(writes[0].created_at > head.created_at);
    assert_eq!(
        buzz_core::meeting::meeting_revision(&writes[0]).unwrap(),
        buzz_core::meeting::MeetingRevision::Head(head.id),
    );
}

#[tokio::test]
async fn update_rejects_a_stale_observed_revision_without_publishing() {
    let channel = Uuid::new_v4();
    let meeting = Uuid::new_v4();
    let (client, requests, server) =
        fixture(|keys| vec![meeting_event(keys, channel, meeting)], "").await;
    let error = dispatch(
        MeetingsCmd::Update {
            channel,
            meeting,
            expected_revision: EventId::from_hex(&"ab".repeat(32)).unwrap(),
            definition: serde_json::to_string(&definition()).unwrap(),
        },
        &client,
        &OutputFormat::Json,
    )
    .await
    .unwrap_err();
    server.abort();
    assert!(matches!(error, CliError::Conflict(_)));
    assert_eq!(
        requests.queries.lock().unwrap()[0][0]["consistency"],
        "strong"
    );
    assert!(requests.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn skip_preserves_calendar_settings_and_guards_the_current_head() {
    let channel = Uuid::new_v4();
    let meeting = Uuid::new_v4();
    let (client, requests, server) =
        fixture(|keys| vec![meeting_event(keys, channel, meeting)], "").await;
    let head = fetch_meeting(&client, channel, meeting, None, true)
        .await
        .unwrap();
    let date = "2026-11-02".parse().unwrap();
    dispatch(
        MeetingsCmd::Skip {
            channel,
            meeting,
            date,
        },
        &client,
        &OutputFormat::Json,
    )
    .await
    .unwrap();
    server.abort();
    let writes = requests.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    let mut expected = definition();
    expected.skipped_dates.push(date);
    assert_eq!(
        parse_channel_meeting(&writes[0]).unwrap().definition,
        expected
    );
    assert_eq!(
        buzz_core::meeting::meeting_revision(&writes[0]).unwrap(),
        buzz_core::meeting::MeetingRevision::Head(head.id),
    );
}

#[tokio::test]
async fn skip_rejects_a_date_outside_the_recurrence_without_publishing() {
    let channel = Uuid::new_v4();
    let meeting = Uuid::new_v4();
    let (client, requests, server) =
        fixture(|keys| vec![meeting_event(keys, channel, meeting)], "").await;
    let error = dispatch(
        MeetingsCmd::Skip {
            channel,
            meeting,
            date: "2026-11-03".parse().unwrap(),
        },
        &client,
        &OutputFormat::Json,
    )
    .await
    .unwrap_err();
    server.abort();
    assert!(matches!(error, CliError::Usage(_)));
    assert!(requests.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn update_cannot_silently_enable_undeliverable_nudges() {
    let channel = Uuid::new_v4();
    let meeting = Uuid::new_v4();
    let (client, requests, server) =
        fixture(|keys| vec![meeting_event(keys, channel, meeting)], "").await;
    let head = fetch_meeting(&client, channel, meeting, None, true)
        .await
        .unwrap();
    let mut updated = definition();
    updated.nudge_minutes_before = Some(5);
    let error = dispatch(
        MeetingsCmd::Update {
            channel,
            meeting,
            expected_revision: head.id,
            definition: serde_json::to_string(&updated).unwrap(),
        },
        &client,
        &OutputFormat::Json,
    )
    .await
    .unwrap_err();
    server.abort();
    assert!(matches!(error, CliError::Usage(_)));
    assert!(requests.writes.lock().unwrap().is_empty());
}

#[test]
fn exact_meeting_replay_is_success_but_a_superseded_write_is_a_conflict() {
    for message in ["duplicate", "duplicate:"] {
        assert!(parse_meeting_write(
            &json!({
                "event_id": "a".repeat(64), "accepted": true, "message": message,
            })
            .to_string()
        )
        .is_ok());
    }
    assert!(matches!(parse_meeting_write(&json!({
        "event_id": "a".repeat(64), "accepted": true, "message": "duplicate: newer event exists",
    }).to_string()), Err(CliError::Conflict(_))));
}

#[test]
fn meeting_definition_input_is_bounded_before_json_deserialization() {
    let mut reader = std::io::Cursor::new(vec![b'x'; MAX_MEETING_CONTENT_BYTES * 2]);
    assert!(matches!(
        read_definition(&mut reader),
        Err(CliError::Usage(_))
    ));
    assert_eq!(reader.position(), (MAX_MEETING_CONTENT_BYTES + 1) as u64);
}
