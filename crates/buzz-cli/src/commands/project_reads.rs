//! Owner-aware reads; project mutation helpers remain signer-self only.

use super::{parse_events, validate_project_slug};
use crate::{client::BuzzClient, commands::read_author_pubkeys, error::CliError};
use buzz_core::kind::KIND_PROJECT;
use nostr::Event;

pub(super) async fn fetch_read_project(
    client: &BuzzClient,
    slug: &str,
    owner: Option<&str>,
) -> Result<Option<Event>, CliError> {
    validate_project_slug(slug)?;
    let authors = read_author_pubkeys(client, owner)?;
    let raw = client
        .query(&serde_json::json!({
            "kinds": [KIND_PROJECT], "authors": authors, "#d": [slug],
            "limit": authors.len(),
        }))
        .await?;
    let mut events = parse_events(&raw)?;
    events.sort_by_key(|event| std::cmp::Reverse(event.created_at));
    let mut seen = std::collections::HashSet::new();
    events.retain(|event| {
        event.kind.as_u16() == KIND_PROJECT as u16
            && authors.contains(&event.pubkey.to_hex())
            && event.tags.iter().any(
                |tag| matches!(tag.as_slice(), [name, value, ..] if name == "d" && value == slug),
            )
            && seen.insert(event.pubkey)
    });
    if events.len() > 1 {
        return Err(CliError::Usage(format!(
            "project {slug:?} exists under multiple owners; pass --owner"
        )));
    }
    Ok(events.pop())
}

/// Get a project from the caller or attested owner, refusing ambiguous slugs.
pub async fn cmd_get(client: &BuzzClient, slug: &str, owner: Option<&str>) -> Result<(), CliError> {
    let event = fetch_read_project(client, slug, owner)
        .await?
        .ok_or_else(|| CliError::NotFound(format!("project {slug:?} not found")))?;
    println!(
        "{}",
        serde_json::json!({
            "event_id": event.id.to_hex(),
            "pubkey": event.pubkey.to_hex(),
            "created_at": event.created_at.as_secs(),
            "kind": event.kind.as_u16(),
            "tags": event.tags.iter().map(|tag| tag.as_slice().to_vec()).collect::<Vec<_>>(),
            "content": event.content,
        })
    );
    Ok(())
}

/// List projects from the caller and attested owner unless explicitly scoped.
pub async fn cmd_list(
    client: &BuzzClient,
    owner: Option<&str>,
    limit: Option<u32>,
) -> Result<(), CliError> {
    let authors = read_author_pubkeys(client, owner)?;
    let mut filter = serde_json::json!({ "kinds": [KIND_PROJECT], "authors": authors });
    if let Some(limit) = limit {
        filter["limit"] = limit.into();
    }
    println!("{}", client.query(&filter).await?);
    Ok(())
}
