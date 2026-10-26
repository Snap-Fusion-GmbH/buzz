//! Channel meeting persistence and timezone-aware occurrence previews.

use buzz_core::kind::KIND_CHANNEL_MEETING;
use buzz_core::meeting::{
    meeting_identifier, parse_channel_meeting, MeetingDefinition, MeetingRecurrence, MeetingStatus,
    MAX_MEETING_CONTENT_BYTES, MEETING_VERSION,
};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use clap::Subcommand;
use nostr::{Event, EventId, PublicKey, Timestamp};
use uuid::Uuid;

use crate::client::{normalize_events, print_create_response, BuzzClient};
use crate::commands::{event_output::format_events, parse_write_response};
use crate::error::CliError;
use crate::OutputFormat;

/// Manage organizer-authored meeting series in a channel.
#[derive(Subcommand)]
pub enum MeetingsCmd {
    /// List signed meeting-series heads, including cancelled series
    List {
        /// Channel UUID
        #[arg(long)]
        channel: Uuid,
        /// Maximum number of signed heads to return
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=1000))]
        limit: u32,
    },
    /// Read a signed meeting series (defaults to your own organizer identity)
    Get {
        /// Channel UUID
        #[arg(long)]
        channel: Uuid,
        /// Meeting UUID
        #[arg(long)]
        meeting: Uuid,
        /// Organizer public key; defaults to the current signer
        #[arg(long)]
        organizer: Option<PublicKey>,
    },
    /// Create a meeting series; automatic nudge delivery is not implemented yet
    Create {
        /// Channel UUID
        #[arg(long)]
        channel: Uuid,
        /// Meeting title
        #[arg(long)]
        title: String,
        /// First local start, e.g. 2026-10-26T10:00:00 (no UTC offset)
        #[arg(long)]
        starts_at: NaiveDateTime,
        /// IANA timezone, e.g. Europe/Berlin
        #[arg(long)]
        timezone: String,
        /// Meeting duration in minutes
        #[arg(long, default_value_t = 30, value_parser = clap::value_parser!(u16).range(1..=1440))]
        duration: u16,
        /// Recurrence anchored on the first meeting's local date
        #[arg(long, default_value = "weekly", value_parser = ["once", "weekly", "fortnightly", "weekdays"])]
        repeat: String,
    },
    /// Preview upcoming UTC occurrences while preserving the meeting's local time
    Occurrences {
        /// Channel UUID
        #[arg(long)]
        channel: Uuid,
        /// Meeting UUID
        #[arg(long)]
        meeting: Uuid,
        /// Organizer public key; defaults to the current signer
        #[arg(long)]
        organizer: Option<PublicKey>,
        /// Inclusive RFC3339 lower bound; defaults to now
        #[arg(long)]
        after: Option<DateTime<Utc>>,
        /// Maximum number of occurrences
        #[arg(long, default_value_t = 3, value_parser = clap::value_parser!(u8).range(1..=32))]
        limit: u8,
    },
    /// Cancel a series authored by the current signer
    Cancel {
        /// Channel UUID
        #[arg(long)]
        channel: Uuid,
        /// Meeting UUID
        #[arg(long)]
        meeting: Uuid,
    },
    /// Replace your meeting definition only if the observed revision still wins
    Update {
        /// Channel UUID
        #[arg(long)]
        channel: Uuid,
        /// Meeting UUID
        #[arg(long)]
        meeting: Uuid,
        /// Signed head event ID from meetings get
        #[arg(long)]
        expected_revision: EventId,
        /// Complete meeting JSON, or - to read it from stdin
        #[arg(long)]
        definition: String,
    },
    /// Skip one local date without shifting a recurring series
    Skip {
        /// Channel UUID
        #[arg(long)]
        channel: Uuid,
        /// Meeting UUID
        #[arg(long)]
        meeting: Uuid,
        /// Local occurrence date, e.g. 2026-11-02
        #[arg(long)]
        date: NaiveDate,
    },
}

/// Execute a meeting command against the configured, immutable relay identity.
pub async fn dispatch(
    command: MeetingsCmd,
    client: &BuzzClient,
    format: &OutputFormat,
) -> Result<(), CliError> {
    match command {
        MeetingsCmd::List { channel, limit } => {
            let filter = serde_json::json!({
                "kinds": [KIND_CHANNEL_MEETING],
                "#h": [channel.to_string()],
            });
            let values = client.query_paginated(filter, limit).await?;
            for value in &values {
                let event: Event = serde_json::from_value(value.clone()).map_err(|error| {
                    CliError::Other(format!("invalid meeting event from relay: {error}"))
                })?;
                let meeting = parse_channel_meeting(&event)
                    .map_err(|error| CliError::Other(error.to_string()))?;
                if meeting.channel_id != channel {
                    return Err(CliError::Other(
                        "relay returned a meeting from a different channel".into(),
                    ));
                }
            }
            println!("{}", format_events(&normalize_events(&values), format));
            Ok(())
        }
        MeetingsCmd::Get {
            channel,
            meeting,
            organizer,
        } => {
            let event = fetch_meeting(client, channel, meeting, organizer, false).await?;
            let value =
                serde_json::to_value(event).map_err(|error| CliError::Other(error.to_string()))?;
            println!("{}", format_events(&normalize_events(&[value]), format));
            Ok(())
        }
        MeetingsCmd::Create {
            channel,
            title,
            starts_at,
            timezone,
            duration,
            repeat,
        } => {
            let recurrence: MeetingRecurrence =
                serde_json::from_value(serde_json::Value::String(repeat))
                    .map_err(|error| CliError::Usage(format!("invalid recurrence: {error}")))?;
            let definition = MeetingDefinition {
                version: MEETING_VERSION,
                title: title.trim().to_string(),
                starts_at,
                timezone,
                duration_minutes: duration,
                recurrence,
                status: MeetingStatus::Active,
                nudge_minutes_before: None,
                skipped_dates: Vec::new(),
            };
            let meeting = Uuid::new_v4();
            let builder = buzz_sdk::build_channel_meeting(channel, meeting, &definition)
                .map_err(|error| CliError::Usage(error.to_string()))?;
            let response = client.submit_event(client.sign_event(builder)?).await?;
            let response = parse_meeting_write(&response)?;
            print_create_response(&response, "meeting_id", &meeting.to_string());
            Ok(())
        }
        MeetingsCmd::Occurrences {
            channel,
            meeting,
            organizer,
            after,
            limit,
        } => {
            let event = fetch_meeting(client, channel, meeting, organizer, false).await?;
            let meeting = parse_channel_meeting(&event)
                .map_err(|error| CliError::Other(error.to_string()))?;
            let occurrences = meeting
                .definition
                .next_occurrences(after.unwrap_or_else(Utc::now), usize::from(limit))
                .map_err(|error| CliError::Usage(error.to_string()))?;
            println!(
                "{}",
                serde_json::to_string(&occurrences)
                    .map_err(|error| CliError::Other(error.to_string()))?
            );
            Ok(())
        }
        MeetingsCmd::Cancel { channel, meeting } => cancel_meeting(client, channel, meeting).await,
        MeetingsCmd::Update {
            channel,
            meeting,
            expected_revision,
            definition,
        } => {
            let text = if definition == "-" {
                read_definition(&mut std::io::stdin().lock())?
            } else {
                if definition.len() > MAX_MEETING_CONTENT_BYTES {
                    return Err(CliError::Usage(
                        "meeting definition exceeds 8192 bytes".into(),
                    ));
                }
                definition
            };
            let definition: MeetingDefinition = serde_json::from_str(&text)
                .map_err(|error| CliError::Usage(format!("invalid meeting definition: {error}")))?;
            let head = fetch_meeting(client, channel, meeting, None, true).await?;
            if head.id != expected_revision {
                return Err(CliError::Conflict(
                    "meeting changed since it was loaded".into(),
                ));
            }
            let prior =
                parse_channel_meeting(&head).map_err(|error| CliError::Other(error.to_string()))?;
            if definition.nudge_minutes_before != prior.definition.nudge_minutes_before {
                return Err(CliError::Usage(
                    "automatic channel nudges are not available yet".into(),
                ));
            }
            println!(
                "{}",
                publish_definition(client, channel, meeting, &head, &definition).await?
            );
            Ok(())
        }
        MeetingsCmd::Skip {
            channel,
            meeting,
            date,
        } => {
            let head = fetch_meeting(client, channel, meeting, None, true).await?;
            let mut definition = parse_channel_meeting(&head)
                .map_err(|error| CliError::Other(error.to_string()))?
                .definition;
            if definition.status == MeetingStatus::Cancelled {
                return Err(CliError::Usage("cannot skip a cancelled meeting".into()));
            }
            if !definition.skipped_dates.contains(&date) {
                definition.skipped_dates.push(date);
            }
            println!(
                "{}",
                publish_definition(client, channel, meeting, &head, &definition).await?
            );
            Ok(())
        }
    }
}

async fn fetch_meeting(
    client: &BuzzClient,
    channel: Uuid,
    meeting: Uuid,
    organizer: Option<PublicKey>,
    strong: bool,
) -> Result<Event, CliError> {
    let organizer = organizer.unwrap_or_else(|| client.keys().public_key());
    let mut filter = serde_json::json!({
        "kinds": [KIND_CHANNEL_MEETING],
        "authors": [organizer.to_hex()],
        "#h": [channel.to_string()],
        "#d": [meeting_identifier(channel, meeting)],
    });
    if strong {
        filter["consistency"] = "strong".into();
    }
    let values = client.query_all_bounded(filter, 1).await?;
    let value = values.into_iter().next().ok_or_else(|| {
        CliError::NotFound("meeting not found for this channel and organizer".into())
    })?;
    let event: Event = serde_json::from_value(value)
        .map_err(|error| CliError::Other(format!("invalid meeting event from relay: {error}")))?;
    let parsed =
        parse_channel_meeting(&event).map_err(|error| CliError::Other(error.to_string()))?;
    if parsed.channel_id != channel || parsed.meeting_id != meeting || event.pubkey != organizer {
        return Err(CliError::Other(
            "relay returned a meeting outside the requested channel or organizer scope".into(),
        ));
    }
    Ok(event)
}

async fn cancel_meeting(client: &BuzzClient, channel: Uuid, meeting: Uuid) -> Result<(), CliError> {
    let head = fetch_meeting(client, channel, meeting, None, true).await?;
    let mut parsed =
        parse_channel_meeting(&head).map_err(|error| CliError::Other(error.to_string()))?;
    if parsed.definition.status == MeetingStatus::Cancelled {
        println!(
            "{}",
            serde_json::json!({ "event_id": head.id.to_hex(), "accepted": true, "message": "already cancelled" })
        );
        return Ok(());
    }
    parsed.definition.status = MeetingStatus::Cancelled;
    println!(
        "{}",
        publish_definition(client, channel, meeting, &head, &parsed.definition).await?
    );
    Ok(())
}

async fn publish_definition(
    client: &BuzzClient,
    channel: Uuid,
    meeting: Uuid,
    head: &Event,
    definition: &MeetingDefinition,
) -> Result<String, CliError> {
    let next_timestamp = head
        .created_at
        .as_secs()
        .checked_add(1)
        .ok_or_else(|| CliError::Other("meeting revision timestamp is out of range".into()))?
        .max(Timestamp::now().as_secs());
    let builder = buzz_sdk::build_channel_meeting_update(channel, meeting, definition, head.id)
        .map_err(|error| CliError::Usage(error.to_string()))?
        .custom_created_at(Timestamp::from(next_timestamp));
    let response = client
        .submit_event(client.sign_event(builder)?)
        .await
        .map_err(|error| match error {
            CliError::Relay { status: 409, body } => CliError::Conflict(body),
            other => other,
        })?;
    parse_meeting_write(&response)
}

fn parse_meeting_write(raw: &str) -> Result<String, CliError> {
    let response: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| CliError::Other(format!("invalid meeting write response: {error}")))?;
    if response["accepted"] == true
        && matches!(
            response["message"].as_str(),
            Some("duplicate" | "duplicate:")
        )
    {
        return Ok(crate::client::normalize_write_response(raw));
    }
    parse_write_response(raw, "meeting write was superseded")
}

fn read_definition(reader: &mut impl std::io::Read) -> Result<String, CliError> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader
        .take((MAX_MEETING_CONTENT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| CliError::Other(format!("could not read meeting definition: {error}")))?;
    if bytes.len() > MAX_MEETING_CONTENT_BYTES {
        return Err(CliError::Usage(
            "meeting definition exceeds 8192 bytes".into(),
        ));
    }
    String::from_utf8(bytes)
        .map_err(|error| CliError::Usage(format!("meeting definition is not UTF-8: {error}")))
}

#[cfg(test)]
#[path = "meetings_tests.rs"]
mod tests;
