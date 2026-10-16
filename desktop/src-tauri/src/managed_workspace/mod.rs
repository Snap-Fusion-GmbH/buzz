mod login;
mod profile;

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use nostr::{EventBuilder, JsonUtil, Kind, Tag};
use oauth2::TokenResponse;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::{
    app_state::AppState, managed_workspace_config::ManagedWorkspaceConfig,
    secret_store::SecretStore,
};

const SESSION_KEY: &str = "workspace-session";

#[derive(Default)]
pub(crate) struct ManagedWorkspaceState {
    generation: AtomicU64,
    pending: Mutex<Option<oneshot::Sender<()>>>,
    refresh: tokio::sync::Mutex<()>,
    store: OnceLock<SecretStore>,
}

impl ManagedWorkspaceState {
    fn check_generation(&self, expected: u64) -> Result<(), String> {
        if self.generation.load(Ordering::Acquire) != expected {
            return Err("Workspace sign-in changed; retry".into());
        }
        Ok(())
    }

    fn store(&self, config: &ManagedWorkspaceConfig) -> &SecretStore {
        self.store
            .get_or_init(|| SecretStore::keyring(config.auth_service()))
    }
}

#[derive(Serialize, Deserialize)]
struct StoredSession {
    workspace_id: String,
    tenant_id: String,
    desktop_client_id: String,
    api_client_id: String,
    base_url: String,
    public_key: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    redirect_uri: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceChannel {
    id: String,
    name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WorkspaceProfile {
    workspace_name: String,
    display_name: Option<String>,
    role: String,
    relay_url: String,
    channels: Vec<WorkspaceChannel>,
    credentials_included: bool,
    teams_message_sync: bool,
}

#[derive(Serialize)]
pub(crate) struct ManagedWorkspaceStatus {
    enabled: bool,
    signed_in: bool,
    workspace_id: Option<String>,
    public_key: Option<String>,
    profile: Option<WorkspaceProfile>,
}

#[derive(Deserialize)]
struct Challenge {
    id: String,
    challenge: String,
    relay_url: String,
    endpoint: String,
}

pub(crate) fn configuration() -> Result<Option<ManagedWorkspaceConfig>, String> {
    option_env!("BUZZ_DESKTOP_BUILD_MANAGED_WORKSPACE")
        .map(ManagedWorkspaceConfig::parse)
        .transpose()
}

pub(crate) fn configured() -> bool {
    option_env!("BUZZ_DESKTOP_BUILD_MANAGED_WORKSPACE").is_some()
}

pub(crate) fn identity_service() -> Option<&'static str> {
    if !configured() {
        return None;
    }
    static SERVICE: OnceLock<String> = OnceLock::new();
    Some(
        SERVICE
            .get_or_init(|| {
                configuration()
                    .ok()
                    .flatten()
                    .map(|config| config.identity_service())
                    .unwrap_or_else(|| "buzz-managed-identity.invalid".to_string())
            })
            .as_str(),
    )
}

fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|_| "System clock is unavailable".to_string())
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Workspace transport unavailable".to_string())
}

async fn response_json<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
) -> Result<T, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Workspace response was interrupted".to_string())?
    {
        if body.len().saturating_add(chunk.len()) > 512 * 1024 {
            return Err("Workspace response exceeds policy".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| "Workspace returned invalid configuration".to_string())
}

async fn profile(
    client: &reqwest::Client,
    config: &ManagedWorkspaceConfig,
    session: &StoredSession,
) -> Result<Option<WorkspaceProfile>, String> {
    let response = client
        .get(format!(
            "{}/v1/workspace",
            config.base_url.trim_end_matches('/')
        ))
        .query(&[("public_key", &session.public_key)])
        .bearer_auth(&session.access_token)
        .send()
        .await
        .map_err(|_| "Workspace verification unavailable".to_string())?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err("Workspace membership verification unavailable".into());
    }
    let result: WorkspaceProfile = response_json(response).await?;
    validate_profile(config, &result)?;
    Ok(Some(result))
}

fn validate_profile(
    config: &ManagedWorkspaceConfig,
    profile: &WorkspaceProfile,
) -> Result<(), String> {
    if profile.relay_url.trim_end_matches('/') != config.relay_url.trim_end_matches('/')
        || profile.credentials_included
        || profile.teams_message_sync
        || !matches!(profile.role.as_str(), "member" | "admin")
        || profile.channels.len() > 500
        || profile
            .channels
            .iter()
            .any(|channel| uuid::Uuid::parse_str(&channel.id).is_err())
    {
        return Err("Workspace configuration does not match this managed build".into());
    }
    Ok(())
}

fn matches_context(
    config: &ManagedWorkspaceConfig,
    session: &StoredSession,
    public_key: &str,
) -> bool {
    session.workspace_id == config.workspace_id
        && session.tenant_id == config.tenant_id
        && session.desktop_client_id == config.desktop_client_id
        && session.api_client_id == config.api_client_id
        && session.base_url == config.base_url
        && session.public_key == public_key
}

async fn renew(
    state: &ManagedWorkspaceState,
    config: &ManagedWorkspaceConfig,
    session: &mut StoredSession,
    generation: u64,
) -> Result<(), String> {
    if now()?.saturating_add(60) < session.expires_at {
        return Ok(());
    }
    let token = login::client(config, &session.redirect_uri)?
        .exchange_refresh_token(&oauth2::RefreshToken::new(session.refresh_token.clone()))
        .add_scope(oauth2::Scope::new(format!(
            "api://{}/workspace.access",
            config.api_client_id
        )))
        .request_async(&login::http_client()?)
        .await
        .map_err(|_| "Microsoft session renewal failed; retry or sign in again".to_string())?;
    session.access_token = token.access_token().secret().clone();
    if let Some(refresh) = token.refresh_token() {
        session.refresh_token = refresh.secret().clone();
    }
    session.expires_at = now()?
        + token
            .expires_in()
            .ok_or("Microsoft did not return a token lifetime")?
            .as_secs();
    state.check_generation(generation)?;
    state.store(config).store(
        SESSION_KEY,
        &serde_json::to_string(session)
            .map_err(|_| "Cannot encode Microsoft session".to_string())?,
    )
}

#[tauri::command]
pub(crate) async fn managed_workspace_status(
    app_state: tauri::State<'_, AppState>,
    state: tauri::State<'_, ManagedWorkspaceState>,
) -> Result<ManagedWorkspaceStatus, String> {
    let Some(config) = configuration()? else {
        return Ok(ManagedWorkspaceStatus {
            enabled: false,
            signed_in: false,
            workspace_id: None,
            public_key: None,
            profile: None,
        });
    };
    if app_state.reset_failed.load(Ordering::Acquire) {
        return Err("managed_workspace_reset_failed".into());
    }
    if app_state.keyring_locked.load(Ordering::Acquire) {
        return Err("managed_workspace_identity_locked".into());
    }
    let keys = app_state.signing_keys()?;
    let public_key = keys.public_key().to_hex();
    let mut result = ManagedWorkspaceStatus {
        enabled: true,
        signed_in: false,
        workspace_id: Some(config.workspace_id.clone()),
        public_key: Some(public_key.clone()),
        profile: None,
    };
    let _refresh = state.refresh.lock().await;
    let generation = state.generation.load(Ordering::Acquire);
    let Some(raw) = state.store(&config).load(SESSION_KEY)? else {
        return Ok(result);
    };
    let mut session: StoredSession =
        serde_json::from_str(&raw).map_err(|_| "Stored Microsoft session is invalid")?;
    if !matches_context(&config, &session, &public_key) {
        return Ok(result);
    }
    renew(&state, &config, &mut session, generation).await?;
    result.profile = profile(&http_client()?, &config, &session).await?;
    state.check_generation(generation)?;
    if app_state.signing_keys()?.public_key() != keys.public_key() {
        return Err("Buzz identity changed; sign in again".into());
    }
    result.signed_in = result.profile.is_some();
    Ok(result)
}

#[tauri::command]
pub(crate) async fn managed_workspace_login(
    app: tauri::AppHandle,
    app_state: tauri::State<'_, AppState>,
    state: tauri::State<'_, ManagedWorkspaceState>,
) -> Result<ManagedWorkspaceStatus, String> {
    let config = configuration()?.ok_or("Managed workspace is not configured")?;
    let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
    let keys = app_state.signing_keys()?;
    let public_key = keys.public_key().to_hex();
    let session = login::interactive(&app, &state, public_key.clone(), generation).await?;
    state.check_generation(generation)?;
    if app_state.signing_keys()?.public_key() != keys.public_key() {
        return Err("Buzz identity changed; sign in again".into());
    }
    let client = http_client()?;
    let endpoint = format!("{}/v1/enrollment", config.base_url.trim_end_matches('/'));
    let response = client
        .post(format!("{endpoint}/challenge"))
        .bearer_auth(&session.access_token)
        .json(&serde_json::json!({"public_key": public_key}))
        .send()
        .await
        .map_err(|_| "Workspace enrollment unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("Workspace enrollment denied or unavailable".into());
    }
    let challenge: Challenge = response_json(response).await?;
    if challenge.relay_url != config.relay_url
        || challenge.endpoint != endpoint
        || !(32..=128).contains(&challenge.challenge.len())
        || uuid::Uuid::parse_str(&challenge.id).is_err()
    {
        return Err("Workspace challenge does not match this managed build".into());
    }
    let proof = EventBuilder::new(Kind::Custom(22242), "")
        .tags([
            Tag::parse(["relay", config.relay_url.as_str()]).map_err(|_| "Invalid relay tag")?,
            Tag::parse(["u", endpoint.as_str()]).map_err(|_| "Invalid endpoint tag")?,
            Tag::parse(["challenge", challenge.challenge.as_str()])
                .map_err(|_| "Invalid challenge tag")?,
        ])
        .sign_with_keys(&keys)
        .map_err(|_| "Cannot prove this Buzz identity".to_string())?;
    state.check_generation(generation)?;
    let response = client
        .post(endpoint)
        .bearer_auth(&session.access_token)
        .json(&serde_json::json!({
            "id": challenge.id, "public_key": public_key, "proof": proof.as_json()
        }))
        .send()
        .await
        .map_err(|_| "Workspace enrollment unavailable".to_string())?;
    if !response.status().is_success() {
        return Err("Workspace enrollment is pending or denied; retry sign-in".into());
    }
    let profile: WorkspaceProfile = response_json(response).await?;
    validate_profile(&config, &profile)?;
    state.check_generation(generation)?;
    profile::ensure_profile(&app_state, &keys, &profile).await?;
    let _refresh = state.refresh.lock().await;
    state.check_generation(generation)?;
    if app_state.signing_keys()?.public_key() != keys.public_key() {
        return Err("Buzz identity changed; sign in again".into());
    }
    state.store(&config).store(
        SESSION_KEY,
        &serde_json::to_string(&session)
            .map_err(|_| "Cannot encode Microsoft session".to_string())?,
    )?;
    Ok(ManagedWorkspaceStatus {
        enabled: true,
        signed_in: true,
        workspace_id: Some(config.workspace_id),
        public_key: Some(public_key),
        profile: Some(profile),
    })
}

#[tauri::command]
pub(crate) fn cancel_managed_workspace_login(
    state: tauri::State<'_, ManagedWorkspaceState>,
) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::AcqRel);
    if let Some(sender) = state
        .pending
        .lock()
        .map_err(|_| "Sign-in state unavailable")?
        .take()
    {
        let _ = sender.send(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ManagedWorkspaceConfig {
        ManagedWorkspaceConfig::parse(
            &serde_json::json!({
                "workspace_id": "fixture",
                "tenant_id": "00000000-0000-4000-8000-000000000001",
                "desktop_client_id": "00000000-0000-4000-8000-000000000002",
                "api_client_id": "00000000-0000-4000-8000-000000000003",
                "base_url": "https://workspace.example.invalid",
                "relay_url": "wss://relay.example.invalid"
            })
            .to_string(),
        )
        .unwrap()
    }

    fn profile() -> WorkspaceProfile {
        WorkspaceProfile {
            workspace_name: "Fixture".into(),
            display_name: None,
            role: "member".into(),
            relay_url: config().relay_url,
            channels: Vec::new(),
            credentials_included: false,
            teams_message_sync: false,
        }
    }

    #[test]
    fn managed_response_cannot_change_the_compiled_relay_or_enable_content_sync() {
        assert!(validate_profile(&config(), &profile()).is_ok());
        for mutation in 0..5 {
            let mut value = profile();
            match mutation {
                0 => value.relay_url = "wss://other.example.invalid".into(),
                1 => value.credentials_included = true,
                2 => value.teams_message_sync = true,
                3 => value.role = "owner".into(),
                _ => value.channels.push(WorkspaceChannel {
                    id: "invalid".into(),
                    name: None,
                }),
            }
            assert!(validate_profile(&config(), &value).is_err());
        }
    }

    #[test]
    fn canceled_or_replaced_sign_in_cannot_commit_old_results() {
        let state = ManagedWorkspaceState::default();
        assert!(state.check_generation(0).is_ok());
        state.generation.fetch_add(1, Ordering::AcqRel);
        assert!(state.check_generation(0).is_err());
        assert!(state.check_generation(1).is_ok());
    }
}
