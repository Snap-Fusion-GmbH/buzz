use buzz_core_pkg::meeting::{
    meeting_identifier, parse_channel_meeting, MeetingDefinition, MeetingOccurrence, MeetingStatus,
};
use chrono::{Duration, Utc};
use nostr::{Event, EventId, Keys, Timestamp};
use serde::{Deserialize, Serialize};
use tauri::State;
use uuid::Uuid;

use crate::app_state::AppState;
use crate::relay::{
    assert_expected_relay_scope, assert_expected_signer, classify_request_error,
    parse_json_response, query_relay_at_with_keys, relay_api_base_url_with_override,
    relay_error_message, submit_signed_event_at_with_keys,
};

const MEETING_PAGE_SIZE: usize = 100;
const MAX_CHANNEL_MEETINGS: usize = 1000;

/// Relay-advertised support for the channel-meeting contract.
#[derive(Debug, Serialize)]
pub struct MeetingSupportWire {
    /// Whether the relay advertises the NIP-CM contract.
    pub supported: bool,
}

#[derive(Default, Deserialize)]
struct MeetingRelayInformation {
    #[serde(default)]
    supported_extensions: Vec<String>,
}

impl MeetingRelayInformation {
    fn supports_meetings(&self) -> bool {
        self.supported_extensions
            .iter()
            .any(|extension| extension == "nip-cm")
    }
}

/// Caller-captured community, channel, and signing identity for meeting IPC.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeetingScopeInput {
    /// Channel UUID.
    pub channel_id: String,
    /// Relay URL captured by the initiating UI.
    pub expected_relay_url: String,
    /// Actual signing identity captured by the initiating UI.
    pub expected_signer_pubkey: String,
}

struct MeetingSession {
    channel: Uuid,
    api_base: String,
    keys: Keys,
}

impl MeetingScopeInput {
    fn bind(&self, api_base: String, keys: Keys) -> Result<MeetingSession, String> {
        if self.expected_relay_url.trim().is_empty()
            || self.expected_signer_pubkey.trim().is_empty()
        {
            return Err("meeting requests require a relay and signing identity".into());
        }
        assert_expected_relay_scope(Some(&self.expected_relay_url), &api_base)?;
        assert_expected_signer(
            Some(&self.expected_signer_pubkey),
            &keys.public_key().to_hex(),
        )?;
        Ok(MeetingSession {
            channel: Uuid::parse_str(&self.channel_id)
                .map_err(|_| "invalid meeting channel UUID")?,
            api_base,
            keys,
        })
    }

    fn capture(&self, state: &AppState) -> Result<MeetingSession, String> {
        self.bind(
            relay_api_base_url_with_override(state),
            state.signing_keys()?,
        )
    }
}

/// A validated meeting head and its next occurrences for the desktop.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingWire {
    /// Stable meeting UUID within the organizer's channel.
    pub id: String,
    /// Signed head event ID used for conflict-checked writes.
    pub revision: String,
    /// Channel UUID.
    pub channel_id: String,
    /// Organizer public key.
    pub organizer_pubkey: String,
    /// Complete protocol definition.
    pub definition: MeetingDefinition,
    /// Ongoing or upcoming occurrences.
    pub occurrences: Vec<MeetingOccurrence>,
    /// Whether the current signer authored the series.
    pub can_manage: bool,
}

fn occurrences(definition: &MeetingDefinition) -> Result<Vec<MeetingOccurrence>, String> {
    let now = Utc::now();
    let after = now - Duration::minutes(i64::from(definition.duration_minutes));
    Ok(definition
        .next_occurrences(after, 4)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|occurrence| occurrence.ends_at > now)
        .take(3)
        .collect())
}

fn meeting_wire(event: &Event, session: &MeetingSession) -> Result<MeetingWire, String> {
    event
        .verify()
        .map_err(|error| format!("invalid meeting signature: {error}"))?;
    let meeting = parse_channel_meeting(event).map_err(|error| error.to_string())?;
    if meeting.channel_id != session.channel {
        return Err("relay returned a meeting from a different channel".into());
    }
    Ok(MeetingWire {
        id: meeting.meeting_id.to_string(),
        revision: event.id.to_hex(),
        channel_id: meeting.channel_id.to_string(),
        organizer_pubkey: event.pubkey.to_hex(),
        occurrences: occurrences(&meeting.definition)?,
        definition: meeting.definition,
        can_manage: event.pubkey == session.keys.public_key(),
    })
}

async fn meeting_support(
    state: &AppState,
    session: &MeetingSession,
) -> Result<MeetingSupportWire, String> {
    let response = state
        .http_client
        .get(format!("{}/info", session.api_base.trim_end_matches('/')))
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|error| classify_request_error(&error))?;
    if !response.status().is_success() {
        return Err(relay_error_message(response).await);
    }
    let info = parse_json_response::<MeetingRelayInformation>(response).await?;
    Ok(MeetingSupportWire {
        supported: info.supports_meetings(),
    })
}

async fn require_meeting_support(state: &AppState, session: &MeetingSession) -> Result<(), String> {
    if !meeting_support(state, session).await?.supported {
        return Err("This workspace's relay needs an update before it can save meetings. Refresh after the relay has been updated; your draft is kept.".into());
    }
    Ok(())
}

/// Discover meeting support without treating an older relay as an empty list.
#[tauri::command]
pub async fn get_channel_meeting_support(
    scope: MeetingScopeInput,
    state: State<'_, AppState>,
) -> Result<MeetingSupportWire, String> {
    let session = scope.capture(&state)?;
    meeting_support(&state, &session).await
}

/// Read all channel meeting heads through a pinned community and signer.
#[tauri::command]
pub async fn get_channel_meetings(
    scope: MeetingScopeInput,
    state: State<'_, AppState>,
) -> Result<Vec<MeetingWire>, String> {
    let session = scope.capture(&state)?;
    require_meeting_support(&state, &session).await?;
    let mut filter = serde_json::json!({
        "kinds": [buzz_core_pkg::kind::KIND_CHANNEL_MEETING],
        "#h": [session.channel.to_string()],
    });
    let mut meetings = Vec::new();
    let mut prior_cursor = None;
    for _ in 0..=MAX_CHANNEL_MEETINGS / MEETING_PAGE_SIZE {
        let page_limit = MEETING_PAGE_SIZE.min(MAX_CHANNEL_MEETINGS + 1 - meetings.len());
        filter["limit"] = page_limit.into();
        let page = query_relay_at_with_keys(
            &state,
            &session.api_base,
            &[filter.clone()],
            &session.keys,
            None,
        )
        .await?;
        if page.len() > page_limit {
            return Err("relay exceeded the meeting query page bound".into());
        }
        for event in &page {
            meetings.push(meeting_wire(event, &session)?);
        }
        if meetings.len() > MAX_CHANNEL_MEETINGS {
            return Err("channel meeting list exceeds the supported 1000-series bound".into());
        }
        if page.len() < page_limit {
            return Ok(meetings);
        }
        let last = page.last().ok_or("meeting pagination did not advance")?;
        let cursor = (last.created_at.as_secs(), last.id.to_hex());
        if prior_cursor.as_ref() == Some(&cursor) {
            return Err("relay did not advance the meeting query cursor".into());
        }
        filter["until"] = cursor.0.into();
        filter["before_id"] = cursor.1.clone().into();
        prior_cursor = Some(cursor);
    }
    Err("meeting query exceeded its page bound".into())
}

/// Validate and preview meeting dates using the shared timezone-aware model.
#[tauri::command]
pub fn preview_meeting_definition(
    definition: MeetingDefinition,
) -> Result<Vec<MeetingOccurrence>, String> {
    occurrences(&definition)
}

async fn own_head(
    state: &AppState,
    session: &MeetingSession,
    meeting_id: Uuid,
) -> Result<Option<Event>, String> {
    let events = query_relay_at_with_keys(
        state,
        &session.api_base,
        &[serde_json::json!({
            "kinds": [buzz_core_pkg::kind::KIND_CHANNEL_MEETING],
            "#h": [session.channel.to_string()],
            "#d": [meeting_identifier(session.channel, meeting_id)],
            "authors": [session.keys.public_key().to_hex()],
            "consistency": "strong",
            "limit": 2,
        })],
        &session.keys,
        None,
    )
    .await?;
    if events.len() > 1 {
        return Err("relay returned multiple live heads for a meeting".into());
    }
    if let Some(event) = events.first() {
        let wire = meeting_wire(event, session)?;
        if wire.id != meeting_id.to_string() || !wire.can_manage {
            return Err("relay returned a meeting outside its organizer scope".into());
        }
    }
    Ok(events.into_iter().next())
}

async fn publish_meeting(
    state: &AppState,
    session: &MeetingSession,
    meeting_id: Uuid,
    definition: &MeetingDefinition,
    head: Option<&Event>,
) -> Result<MeetingWire, String> {
    let builder = match head {
        Some(head) => {
            let next = head
                .created_at
                .as_secs()
                .checked_add(1)
                .ok_or("meeting revision timestamp is out of range")?
                .max(Timestamp::now().as_secs());
            buzz_sdk_pkg::build_channel_meeting_update(
                session.channel,
                meeting_id,
                definition,
                head.id,
            )
            .map_err(|error| error.to_string())?
            .custom_created_at(Timestamp::from(next))
        }
        None => buzz_sdk_pkg::build_channel_meeting(session.channel, meeting_id, definition)
            .map_err(|error| error.to_string())?,
    };
    let signed = builder
        .sign_with_keys(&session.keys)
        .map_err(|error| error.to_string())?;
    let receipt = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        submit_signed_event_at_with_keys(&signed, state, &session.api_base, &session.keys),
    )
    .await
    .map_err(|_| {
        "meeting save timed out; refresh before retrying because it may have been accepted"
    })??;
    if receipt.message.starts_with("duplicate") {
        let current = own_head(state, session, meeting_id)
            .await?
            .ok_or("meeting head was not found after duplicate acknowledgement")?;
        if parse_channel_meeting(&current)
            .map_err(|error| error.to_string())?
            .definition
            != *definition
        {
            return Err("conflict: meeting save was superseded; refresh and try again".into());
        }
        return meeting_wire(&current, session);
    }
    meeting_wire(&signed, session)
}

fn require_revision(head: &Event, expected_revision: &str) -> Result<(), String> {
    let expected = EventId::from_hex(expected_revision).map_err(|_| "invalid meeting revision")?;
    if head.id != expected {
        return Err("conflict: meeting changed since it was loaded; refresh and try again".into());
    }
    Ok(())
}

/// Create a stable draft UUID or replace an organizer's expected meeting head.
#[tauri::command]
pub async fn save_channel_meeting(
    scope: MeetingScopeInput,
    meeting_id: String,
    definition: MeetingDefinition,
    expected_revision: Option<String>,
    state: State<'_, AppState>,
) -> Result<MeetingWire, String> {
    let session = scope.capture(&state)?;
    require_meeting_support(&state, &session).await?;
    let meeting_id = Uuid::parse_str(&meeting_id).map_err(|_| "invalid meeting UUID")?;
    definition.validate().map_err(|error| error.to_string())?;
    if definition.status != MeetingStatus::Active {
        return Err("use the cancel action to cancel a meeting".into());
    }
    let head = own_head(&state, &session, meeting_id).await?;
    match (head.as_ref(), expected_revision.as_deref()) {
        (Some(head), None)
            if parse_channel_meeting(head)
                .map_err(|error| error.to_string())?
                .definition
                == definition =>
        {
            return meeting_wire(head, &session)
        }
        (Some(head), Some(expected)) => require_revision(head, expected)?,
        (None, None) => {}
        _ => {
            return Err(
                "conflict: meeting changed since it was loaded; refresh and try again".into(),
            )
        }
    }
    let prior_nudge = head
        .as_ref()
        .map(parse_channel_meeting)
        .transpose()
        .map_err(|error| error.to_string())?
        .and_then(|meeting| meeting.definition.nudge_minutes_before);
    if definition.nudge_minutes_before != prior_nudge {
        return Err("automatic channel nudges are not available yet".into());
    }
    publish_meeting(&state, &session, meeting_id, &definition, head.as_ref()).await
}

/// Cancel a meeting series or skip one local occurrence with a revision guard.
#[tauri::command]
pub async fn change_channel_meeting(
    scope: MeetingScopeInput,
    meeting_id: String,
    expected_revision: String,
    skip_date: Option<String>,
    state: State<'_, AppState>,
) -> Result<MeetingWire, String> {
    let session = scope.capture(&state)?;
    require_meeting_support(&state, &session).await?;
    let meeting_id = Uuid::parse_str(&meeting_id).map_err(|_| "invalid meeting UUID")?;
    let head = own_head(&state, &session, meeting_id)
        .await?
        .ok_or("meeting not found for the current organizer")?;
    require_revision(&head, &expected_revision)?;
    let mut definition = parse_channel_meeting(&head)
        .map_err(|error| error.to_string())?
        .definition;
    match skip_date {
        Some(date) => {
            let date = date.parse().map_err(|_| "invalid skipped meeting date")?;
            if !definition.skipped_dates.contains(&date) {
                definition.skipped_dates.push(date);
            }
        }
        None => definition.status = MeetingStatus::Cancelled,
    }
    publish_meeting(&state, &session, meeting_id, &definition, Some(&head)).await
}

#[cfg(test)]
#[path = "meetings_tests.rs"]
mod tests;
