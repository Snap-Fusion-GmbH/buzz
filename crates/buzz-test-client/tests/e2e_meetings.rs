use base64::{engine::general_purpose::STANDARD, Engine};
use buzz_core::meeting::{
    parse_channel_meeting, MeetingDefinition, MeetingRecurrence, MeetingStatus, MEETING_VERSION,
};
use buzz_sdk::{build_channel_meeting, build_channel_meeting_update};
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn relay_http_url() -> String {
    std::env::var("RELAY_URL")
        .unwrap_or_else(|_| "ws://localhost:3000".into())
        .replace("wss://", "https://")
        .replace("ws://", "http://")
        .trim_end_matches('/')
        .to_string()
}

async fn post(client: &Client, keys: &Keys, path: &str, payload: Value) -> (StatusCode, Value) {
    let url = format!("{}{path}", relay_http_url());
    let body = serde_json::to_vec(&payload).unwrap();
    let auth = EventBuilder::new(Kind::Custom(27235), "")
        .tags([
            Tag::parse(["u", &url]).unwrap(),
            Tag::parse(["method", "POST"]).unwrap(),
            Tag::parse(["payload", &hex::encode(Sha256::digest(&body))]).unwrap(),
            Tag::parse(["nonce", &Uuid::new_v4().to_string()]).unwrap(),
        ])
        .sign_with_keys(keys)
        .unwrap();
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            format!(
                "Nostr {}",
                STANDARD.encode(serde_json::to_vec(&auth).unwrap())
            ),
        )
        .body(body)
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.json().await.unwrap();
    (status, body)
}

async fn publish(client: &Client, keys: &Keys, event: &Event) -> (StatusCode, Value) {
    post(
        client,
        keys,
        "/events",
        serde_json::to_value(event).unwrap(),
    )
    .await
}

async fn head(client: &Client, keys: &Keys, channel: Uuid) -> Event {
    let (status, result) = post(
        client,
        keys,
        "/query",
        json!([{
            "kinds": [buzz_core::kind::KIND_CHANNEL_MEETING],
            "#h": [channel.to_string()],
            "consistency": "strong",
        }]),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{result}");
    let events: Vec<Event> = serde_json::from_value(result).unwrap();
    assert_eq!(events.len(), 1);
    events.into_iter().next().unwrap()
}

#[tokio::test]
#[ignore = "requires a running isolated local relay"]
async fn meetings_create_conflict_privacy_cancel_and_replay_use_the_live_relay() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap();
    let owner = Keys::generate();
    let outsider = Keys::generate();
    let channel = Uuid::new_v4();
    let create = buzz_sdk::build_create_channel(
        channel,
        &format!("meetings-e2e-{channel}"),
        Some(buzz_sdk::Visibility::Private),
        Some(buzz_sdk::ChannelKind::Stream),
        None,
        None,
    )
    .unwrap()
    .sign_with_keys(&owner)
    .unwrap();
    let (status, response) = publish(&client, &owner, &create).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["accepted"], true);

    let meeting_id = Uuid::new_v4();
    let definition = MeetingDefinition {
        version: MEETING_VERSION,
        title: "Weekly planning".into(),
        starts_at: "2099-10-26T10:00:00".parse().unwrap(),
        timezone: "Europe/Berlin".into(),
        duration_minutes: 30,
        recurrence: MeetingRecurrence::Weekly,
        status: MeetingStatus::Active,
        nudge_minutes_before: None,
        skipped_dates: Vec::new(),
    };
    let initial = build_channel_meeting(channel, meeting_id, &definition)
        .unwrap()
        .sign_with_keys(&owner)
        .unwrap();
    let (status, response) = publish(&client, &owner, &initial).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(head(&client, &owner, channel).await.id, initial.id);

    let (status, private_read) = post(
        &client,
        &outsider,
        "/query",
        json!([{
            "kinds": [buzz_core::kind::KIND_CHANNEL_MEETING],
            "#h": [channel.to_string()],
        }]),
    )
    .await;
    assert!(
        status == StatusCode::FORBIDDEN || (status == StatusCode::OK && private_read == json!([])),
        "private meeting leaked: {status} {private_read}",
    );

    let mut other_create = definition.clone();
    other_create.title = "Must not replace an existing meeting".into();
    let duplicate_coordinate = build_channel_meeting(channel, meeting_id, &other_create)
        .unwrap()
        .custom_created_at(Timestamp::from(initial.created_at.as_secs() + 4))
        .sign_with_keys(&owner)
        .unwrap();
    let (status, _) = publish(&client, &owner, &duplicate_coordinate).await;
    assert_eq!(status, StatusCode::CONFLICT);

    let mut first_definition = definition.clone();
    first_definition.title = "First concurrent edit".into();
    let mut second_definition = definition.clone();
    second_definition.title = "Second concurrent edit".into();
    let first = build_channel_meeting_update(channel, meeting_id, &first_definition, initial.id)
        .unwrap()
        .custom_created_at(Timestamp::from(initial.created_at.as_secs() + 1))
        .sign_with_keys(&owner)
        .unwrap();
    let second = build_channel_meeting_update(channel, meeting_id, &second_definition, initial.id)
        .unwrap()
        .custom_created_at(Timestamp::from(initial.created_at.as_secs() + 1))
        .sign_with_keys(&owner)
        .unwrap();
    let (first_result, second_result) = tokio::join!(
        publish(&client, &owner, &first),
        publish(&client, &owner, &second),
    );
    assert!(
        (first_result.0 == StatusCode::OK && second_result.0 == StatusCode::CONFLICT)
            || (first_result.0 == StatusCode::CONFLICT && second_result.0 == StatusCode::OK),
        "concurrent updates were not serialized: {first_result:?} {second_result:?}",
    );
    let current = head(&client, &owner, channel).await;
    assert_eq!(
        current.id,
        if first_result.0 == StatusCode::OK {
            first.id
        } else {
            second.id
        }
    );

    let mut cancelled = parse_channel_meeting(&current).unwrap().definition;
    cancelled.status = MeetingStatus::Cancelled;
    let stale_cancel = build_channel_meeting_update(channel, meeting_id, &cancelled, initial.id)
        .unwrap()
        .custom_created_at(Timestamp::from(current.created_at.as_secs() + 1))
        .sign_with_keys(&owner)
        .unwrap();
    assert_eq!(
        publish(&client, &owner, &stale_cancel).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(head(&client, &owner, channel).await.id, current.id);
    let cancel = build_channel_meeting_update(channel, meeting_id, &cancelled, current.id)
        .unwrap()
        .custom_created_at(Timestamp::from(current.created_at.as_secs() + 1))
        .sign_with_keys(&owner)
        .unwrap();
    let (status, response) = publish(&client, &owner, &cancel).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    let final_head = head(&client, &owner, channel).await;
    assert_eq!(final_head.id, cancel.id);
    assert_eq!(
        parse_channel_meeting(&final_head)
            .unwrap()
            .definition
            .status,
        MeetingStatus::Cancelled
    );
    let (status, replay) = publish(&client, &owner, &cancel).await;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["accepted"], true);
}
