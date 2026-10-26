use buzz_core::meeting::{
    meeting_identifier, meeting_revision, parse_channel_meeting, MeetingRevision,
};
use buzz_core::{StoredEvent, TenantContext};
use buzz_db::replaceable::{ParameterizedReplacePrecondition, ParameterizedReplaceStatus};
use nostr::Event;
use uuid::Uuid;

use super::ingest::IngestError;
use crate::state::AppState;

pub(super) async fn persist_meeting(
    state: &AppState,
    tenant: &TenantContext,
    event: &Event,
    channel_id: Option<Uuid>,
) -> Result<(StoredEvent, bool), IngestError> {
    let meeting = parse_channel_meeting(event)
        .map_err(|error| IngestError::Rejected(format!("invalid: {error}")))?;
    let revision = meeting_revision(event)
        .map_err(|error| IngestError::Rejected(format!("invalid: {error}")))?;
    let precondition = match &revision {
        MeetingRevision::Unconditional => ParameterizedReplacePrecondition::Unconditional,
        MeetingRevision::NoHead => ParameterizedReplacePrecondition::ExpectNoHead,
        MeetingRevision::Head(head) => {
            ParameterizedReplacePrecondition::ExpectedRevision(head.as_bytes())
        }
    };
    let mut transaction = state
        .db
        .begin_event_write_transaction(tenant.community())
        .await
        .map_err(|error| IngestError::Internal(format!("error: meeting transaction: {error}")))?;
    let result = state
        .db
        .replace_parameterized_event_in_transaction(
            &mut transaction,
            event,
            &meeting_identifier(meeting.channel_id, meeting.meeting_id),
            channel_id,
            precondition,
        )
        .await
        .map_err(|error| IngestError::Internal(format!("error: meeting save: {error}")))?;
    let inserted = result.status == ParameterizedReplaceStatus::Inserted;
    if inserted {
        transaction
            .commit()
            .await
            .map_err(|error| IngestError::Internal(format!("error: meeting commit: {error}")))?;
    } else {
        transaction
            .rollback()
            .await
            .map_err(|error| IngestError::Internal(format!("error: meeting rollback: {error}")))?;
    }
    match result.status {
        ParameterizedReplaceStatus::Inserted | ParameterizedReplaceStatus::Duplicate => {
            Ok((result.event, inserted))
        }
        ParameterizedReplaceStatus::Superseded if revision == MeetingRevision::Unconditional => {
            Ok((result.event, false))
        }
        ParameterizedReplaceStatus::Superseded
        | ParameterizedReplaceStatus::RevisionMissing
        | ParameterizedReplaceStatus::RevisionMismatch => Err(IngestError::MeetingConflict(
            "conflict: meeting changed since it was loaded; refresh and try again".into(),
        )),
        ParameterizedReplaceStatus::ReplayOnlyMiss => Err(IngestError::Internal(
            "error: unexpected meeting replay condition".into(),
        )),
    }
}
