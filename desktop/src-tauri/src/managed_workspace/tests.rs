use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Form, Json, Router,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU16, AtomicUsize},
        Arc,
    },
};

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

#[test]
fn damaged_session_data_requires_session_recovery_not_identity_replacement() {
    for raw in ["not-json", "[]", "{}"] {
        assert_eq!(
            decode_session(raw).err().unwrap(),
            "managed_workspace_session_recovery_required"
        );
    }
}

struct ServiceState {
    keys: Keys,
    profile_status: AtomicU16,
    profile_unauthorized: AtomicUsize,
    enrollment_missing: AtomicUsize,
    enrollments: AtomicUsize,
    accepted_access: Mutex<String>,
    expected_refresh: Mutex<String>,
    token_status: AtomicU16,
    token_requests: AtomicUsize,
    token_error: Mutex<String>,
}

async fn workspace_response(
    State(service): State<Arc<ServiceState>>,
    headers: HeaderMap,
) -> Response {
    assert_bearer(&service, &headers);
    let unauthorized = service
        .profile_unauthorized
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
            remaining.checked_sub(1)
        })
        .is_ok();
    let status = if unauthorized {
        StatusCode::UNAUTHORIZED
    } else {
        StatusCode::from_u16(service.profile_status.load(Ordering::Acquire)).unwrap()
    };
    if status == StatusCode::FORBIDDEN {
        return (
            status,
            Json(serde_json::json!({"detail": "Current R&D membership required"})),
        )
            .into_response();
    }
    let missing = service.enrollment_missing.load(Ordering::Acquire);
    if status.is_success() && missing != 0 {
        let detail = if missing == 2 {
            "Enrollment must be restored"
        } else {
            "This Buzz identity is not enrolled"
        };
        let mut response = (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"detail": detail})),
        )
            .into_response();
        if missing == 2 {
            response.headers_mut().insert(
                "X-Buzz-Workspace-State",
                HeaderValue::from_static("enrollment-required"),
            );
        }
        return response;
    }
    (status, Json(serde_json::to_value(profile()).unwrap())).into_response()
}

fn assert_bearer(service: &ServiceState, headers: &HeaderMap) {
    assert_eq!(
        headers.get("Authorization").unwrap().to_str().unwrap(),
        format!("Bearer {}", service.accepted_access.lock().unwrap())
    );
}

async fn challenge_response(
    State(service): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(request): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    assert_bearer(&service, &headers);
    assert_eq!(request["public_key"], service.keys.public_key().to_hex());
    Json(serde_json::json!({
        "id": "00000000-0000-4000-8000-000000000004",
        "challenge": "fixture-enrollment-challenge-00000000000000000000",
        "relay_url": profile().relay_url,
        "endpoint": format!("http://{}/v1/enrollment", headers["host"].to_str().unwrap())
    }))
}

async fn enrollment_response(
    State(service): State<Arc<ServiceState>>,
    headers: HeaderMap,
    Json(request): Json<serde_json::Value>,
) -> Json<WorkspaceProfile> {
    assert_bearer(&service, &headers);
    assert_eq!(request["id"], "00000000-0000-4000-8000-000000000004");
    assert_eq!(request["public_key"], service.keys.public_key().to_hex());
    let event = nostr::Event::from_json(request["proof"].as_str().unwrap()).unwrap();
    assert!(event.verify().is_ok());
    assert_eq!(event.pubkey, service.keys.public_key());
    assert_eq!(event.kind, Kind::Custom(22242));
    assert!(event.content.is_empty());
    let tags: Vec<Vec<String>> = event
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    assert_eq!(tags.len(), 3);
    assert!(tags.contains(&vec!["relay".into(), profile().relay_url]));
    assert!(tags.contains(&vec![
        "u".into(),
        format!("http://{}/v1/enrollment", headers["host"].to_str().unwrap())
    ]));
    assert!(tags.contains(&vec![
        "challenge".into(),
        "fixture-enrollment-challenge-00000000000000000000".into()
    ]));
    service.enrollment_missing.store(0, Ordering::Release);
    service.enrollments.fetch_add(1, Ordering::AcqRel);
    Json(profile())
}

async fn token_response(
    State(service): State<Arc<ServiceState>>,
    Form(form): Form<HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    assert_eq!(form.get("grant_type").unwrap(), "refresh_token");
    assert_eq!(
        form.get("refresh_token").unwrap(),
        &*service.expected_refresh.lock().unwrap()
    );
    service.token_requests.fetch_add(1, Ordering::AcqRel);
    let status = StatusCode::from_u16(service.token_status.load(Ordering::Acquire)).unwrap();
    let response = if status.is_success() {
        *service.accepted_access.lock().unwrap() = "fixture-renewed-access".into();
        *service.expected_refresh.lock().unwrap() = "fixture-rotated-refresh".into();
        serde_json::json!({
            "access_token": "fixture-renewed-access",
            "refresh_token": "fixture-rotated-refresh",
            "token_type": "Bearer",
            "expires_in": 3600
        })
    } else {
        serde_json::json!({"error": service.token_error.lock().unwrap().clone()})
    };
    (status, Json(response))
}

struct TestService {
    state: Arc<ServiceState>,
    address: String,
    worker: tokio::task::JoinHandle<()>,
}

impl Drop for TestService {
    fn drop(&mut self) {
        self.worker.abort();
    }
}

impl TestService {
    async fn start() -> Self {
        let state = Arc::new(ServiceState {
            keys: Keys::generate(),
            profile_status: AtomicU16::new(200),
            profile_unauthorized: AtomicUsize::new(0),
            enrollment_missing: AtomicUsize::new(0),
            enrollments: AtomicUsize::new(0),
            accepted_access: Mutex::new("fixture-original-access".into()),
            expected_refresh: Mutex::new("fixture-original-refresh".into()),
            token_status: AtomicU16::new(200),
            token_requests: AtomicUsize::new(0),
            token_error: Mutex::new("temporarily_unavailable".into()),
        });
        let router = Router::new()
            .route("/v1/workspace", get(workspace_response))
            .route("/v1/enrollment/challenge", post(challenge_response))
            .route("/v1/enrollment", post(enrollment_response))
            .route("/token", post(token_response))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let worker = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            state,
            address,
            worker,
        }
    }

    fn client(&self, config: &ManagedWorkspaceConfig) -> login::MicrosoftClient {
        login::client(config, "http://localhost:12345/callback")
            .unwrap()
            .set_token_uri(oauth2::TokenUrl::new(format!("{}/token", self.address)).unwrap())
    }

    async fn verify(
        &self,
        state: &ManagedWorkspaceState,
        config: &ManagedWorkspaceConfig,
        session: &mut StoredSession,
    ) -> Result<WorkspaceProfile, String> {
        verify_session(
            state,
            config,
            session,
            &self.state.keys,
            0,
            self.client(config),
        )
        .await
    }

    async fn assert_ready(
        &self,
        state: &ManagedWorkspaceState,
        config: &ManagedWorkspaceConfig,
        session: &mut StoredSession,
    ) {
        let profile = self.verify(state, config, session).await.unwrap();
        assert_eq!(profile.role, "member");
    }
}

#[cfg(feature = "system-keyring")]
#[tokio::test]
async fn existing_session_survives_outages_and_renews_without_interactive_login() {
    keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
    let service = TestService::start().await;
    let transport = &service.state;
    let mut config = config();
    config.workspace_id = format!("session-recovery-{}", uuid::Uuid::new_v4());
    config.base_url = service.address.clone();
    let state = ManagedWorkspaceState::default();
    let public_key = transport.keys.public_key().to_hex();
    let mut session = StoredSession {
        workspace_id: config.workspace_id.clone(),
        tenant_id: config.tenant_id.clone(),
        desktop_client_id: config.desktop_client_id.clone(),
        api_client_id: config.api_client_id.clone(),
        base_url: config.base_url.clone(),
        public_key: public_key.clone(),
        access_token: "fixture-original-access".into(),
        refresh_token: "fixture-original-refresh".into(),
        expires_at: now().unwrap() + 3600,
        redirect_uri: "http://localhost:12345/callback".into(),
    };
    let original = serde_json::to_string(&session).unwrap();
    state.store(&config).store(SESSION_KEY, &original).unwrap();

    service.assert_ready(&state, &config, &mut session).await;
    assert_eq!(transport.token_requests.load(Ordering::Acquire), 0);

    for missing in [1, 2] {
        transport
            .enrollment_missing
            .store(missing, Ordering::Release);
        service.assert_ready(&state, &config, &mut session).await;
        assert_eq!(transport.enrollments.load(Ordering::Acquire), missing);
        assert_eq!(transport.token_requests.load(Ordering::Acquire), 0);
        assert_eq!(session.public_key, public_key);
        assert_eq!(
            state.store(&config).load(SESSION_KEY).unwrap(),
            Some(original.clone())
        );
    }

    for (status, expected) in [
        (503, "managed_workspace_unavailable"),
        (429, "managed_workspace_unavailable"),
        (403, "managed_workspace_access_denied"),
    ] {
        transport.profile_status.store(status, Ordering::Release);
        let error = service
            .verify(&state, &config, &mut session)
            .await
            .err()
            .unwrap();
        assert_eq!(error, expected);
        assert_eq!(
            state.store(&config).load(SESSION_KEY).unwrap(),
            Some(original.clone())
        );
        assert_eq!(transport.token_requests.load(Ordering::Acquire), 0);
        transport.profile_status.store(200, Ordering::Release);
        service.assert_ready(&state, &config, &mut session).await;
    }

    transport.profile_unauthorized.store(1, Ordering::Release);
    service.assert_ready(&state, &config, &mut session).await;
    assert_eq!(transport.token_requests.load(Ordering::Acquire), 1);
    assert_eq!(session.access_token, "fixture-renewed-access");
    assert_eq!(session.refresh_token, "fixture-rotated-refresh");
    let renewed = state.store(&config).load(SESSION_KEY).unwrap().unwrap();
    assert_eq!(renewed, serde_json::to_string(&session).unwrap());

    transport.profile_status.store(401, Ordering::Release);
    let error = service
        .verify(&state, &config, &mut session)
        .await
        .err()
        .unwrap();
    assert_eq!(error, "managed_workspace_unavailable");
    assert_eq!(transport.token_requests.load(Ordering::Acquire), 2);
    transport.profile_status.store(200, Ordering::Release);
    session.expires_at = 0;

    for (status, error, expected) in [
        (
            503,
            "temporarily_unavailable",
            "managed_workspace_unavailable",
        ),
        (400, "invalid_client", "managed_workspace_unavailable"),
        (400, "invalid_grant", "managed_workspace_sign_in_required"),
        (
            400,
            "interaction_required",
            "managed_workspace_sign_in_required",
        ),
        (400, "login_required", "managed_workspace_sign_in_required"),
        (
            400,
            "consent_required",
            "managed_workspace_sign_in_required",
        ),
    ] {
        transport.token_status.store(status, Ordering::Release);
        *transport.token_error.lock().unwrap() = error.into();
        let saved = state.store(&config).load(SESSION_KEY).unwrap();
        let error = service
            .verify(&state, &config, &mut session)
            .await
            .err()
            .unwrap();
        assert_eq!(error, expected);
        assert_eq!(state.store(&config).load(SESSION_KEY).unwrap(), saved);
        assert_eq!(session.refresh_token, "fixture-rotated-refresh");
    }

    transport.token_status.store(200, Ordering::Release);
    service.assert_ready(&state, &config, &mut session).await;
    assert!(session.expires_at > now().unwrap() + 60);
    assert_eq!(session.public_key, public_key);

    let saved = state.store(&config).load(SESSION_KEY).unwrap();
    session.expires_at = 0;
    state.generation.fetch_add(1, Ordering::AcqRel);
    assert!(service.verify(&state, &config, &mut session).await.is_err());
    assert_eq!(state.store(&config).load(SESSION_KEY).unwrap(), saved);
}
