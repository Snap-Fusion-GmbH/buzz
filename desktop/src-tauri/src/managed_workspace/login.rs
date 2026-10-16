use std::{collections::HashMap, sync::Mutex, time::Duration};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
use oauth2::{
    basic::BasicClient, AuthType, AuthUrl, ClientId, CsrfToken, EndpointNotSet, EndpointSet,
    PkceCodeChallenge, RedirectUrl, Scope, TokenResponse, TokenUrl,
};
use tauri_plugin_opener::OpenerExt;
use tokio::{net::TcpListener, sync::oneshot};

use super::{configuration, ManagedWorkspaceState, StoredSession};

type MicrosoftClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointNotSet, EndpointSet>;

struct CallbackState {
    expected_state: String,
    sender: Mutex<Option<oneshot::Sender<Result<String, String>>>>,
}

struct CallbackServer(tokio::task::JoinHandle<()>);

impl Drop for CallbackServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn callback(
    Query(query): Query<HashMap<String, String>>,
    State(state): State<std::sync::Arc<CallbackState>>,
) -> Response {
    if query.get("state") != Some(&state.expected_state) {
        return (StatusCode::BAD_REQUEST, "Sign-in state did not match").into_response();
    }
    let result = query
        .get("code")
        .filter(|code| !code.is_empty() && code.len() < 16_384)
        .cloned()
        .ok_or_else(|| "Microsoft sign-in was not completed".to_string());
    let sender = match state.sender.lock() {
        Ok(mut sender) => sender.take(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    if let Some(sender) = sender {
        let _ = sender.send(result);
        (
            [
                ("Cache-Control", "no-store"),
                ("Referrer-Policy", "no-referrer"),
                ("Content-Security-Policy", "default-src 'none'"),
            ],
            Html(
                "<!doctype html><title>Snap Fusion Buzz</title>\
                 <h1>Sign-in received</h1><p>You can return to Buzz.</p>",
            ),
        )
            .into_response()
    } else {
        StatusCode::CONFLICT.into_response()
    }
}

pub(super) fn client(
    config: &crate::managed_workspace_config::ManagedWorkspaceConfig,
    redirect: &str,
) -> Result<MicrosoftClient, String> {
    let authority = format!(
        "https://login.microsoftonline.com/{}/oauth2/v2.0",
        config.tenant_id
    );
    Ok(
        BasicClient::new(ClientId::new(config.desktop_client_id.clone()))
            .set_auth_uri(
                AuthUrl::new(format!("{authority}/authorize"))
                    .map_err(|_| "Microsoft authority is invalid".to_string())?,
            )
            .set_token_uri(
                TokenUrl::new(format!("{authority}/token"))
                    .map_err(|_| "Microsoft token endpoint is invalid".to_string())?,
            )
            .set_redirect_uri(
                RedirectUrl::new(redirect.to_string())
                    .map_err(|_| "Microsoft callback is invalid".to_string())?,
            )
            .set_auth_type(AuthType::RequestBody),
    )
}

pub(super) fn http_client() -> Result<oauth2::reqwest::Client, String> {
    oauth2::reqwest::Client::builder()
        .redirect(oauth2::reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "Microsoft transport unavailable".to_string())
}

pub(super) async fn interactive(
    app: &tauri::AppHandle,
    state: &ManagedWorkspaceState,
    public_key: String,
    generation: u64,
) -> Result<StoredSession, String> {
    let config = configuration()?.ok_or("Managed workspace is not configured")?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Cannot start Microsoft sign-in callback".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Cannot read Microsoft callback address".to_string())?
        .port();
    let redirect = format!("http://localhost:{port}/callback");
    let client = client(&config, &redirect)?;
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, csrf) = client
        .authorize_url(CsrfToken::new_random)
        .add_scope(Scope::new(format!(
            "api://{}/workspace.access",
            config.api_client_id
        )))
        .add_scope(Scope::new("openid".to_string()))
        .add_scope(Scope::new("profile".to_string()))
        .add_scope(Scope::new("offline_access".to_string()))
        .set_pkce_challenge(challenge)
        .url();
    let (sender, receiver) = oneshot::channel();
    let callback_state = std::sync::Arc::new(CallbackState {
        expected_state: csrf.secret().clone(),
        sender: Mutex::new(Some(sender)),
    });
    let router = Router::new()
        .route("/callback", get(callback))
        .with_state(callback_state);
    let _server = CallbackServer(tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    }));
    let (cancel, canceled) = oneshot::channel();
    {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "Sign-in state unavailable")?;
        if let Some(previous) = pending.take() {
            let _ = previous.send(());
        }
        *pending = Some(cancel);
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "Cannot open Microsoft sign-in".to_string())?;
    let code = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(600), receiver) => {
            result.map_err(|_| "Microsoft sign-in timed out".to_string())?
                .map_err(|_| "Microsoft callback stopped".to_string())??
        }
        _ = canceled => return Err("Microsoft sign-in canceled".to_string()),
    };
    state.check_generation(generation)?;
    let token = client
        .exchange_code(oauth2::AuthorizationCode::new(code))
        .set_pkce_verifier(verifier)
        .request_async(&http_client()?)
        .await
        .map_err(|_| "Microsoft sign-in exchange failed".to_string())?;
    let expires = token
        .expires_in()
        .ok_or("Microsoft did not return a token lifetime")?
        .as_secs();
    let refresh_token = token
        .refresh_token()
        .ok_or("Microsoft did not authorize session renewal")?
        .secret()
        .clone();
    state.check_generation(generation)?;
    Ok(StoredSession {
        workspace_id: config.workspace_id,
        tenant_id: config.tenant_id,
        desktop_client_id: config.desktop_client_id,
        api_client_id: config.api_client_id,
        base_url: config.base_url,
        public_key,
        access_token: token.access_token().secret().clone(),
        refresh_token,
        expires_at: super::now()? + expires,
        redirect_uri: redirect,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn query(state: &str, code: &str) -> Query<HashMap<String, String>> {
        Query(HashMap::from([
            ("state".into(), state.into()),
            ("code".into(), code.into()),
        ]))
    }

    #[tokio::test]
    async fn wrong_state_does_not_consume_the_callback() {
        let (sender, mut receiver) = oneshot::channel();
        let state = Arc::new(CallbackState {
            expected_state: "expected-fixture".into(),
            sender: Mutex::new(Some(sender)),
        });
        let rejected = callback(query("wrong", "fixture-code"), State(state.clone())).await;
        assert_eq!(rejected.status(), StatusCode::BAD_REQUEST);
        assert!(matches!(
            receiver.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        let accepted = callback(
            query("expected-fixture", "fixture-code"),
            State(state.clone()),
        )
        .await;
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(receiver.await.unwrap().unwrap(), "fixture-code");
        let repeated = callback(query("expected-fixture", "fixture-code"), State(state)).await;
        assert_eq!(repeated.status(), StatusCode::CONFLICT);
        let body = axum::body::to_bytes(accepted.into_body(), 4096)
            .await
            .unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("fixture-code"));
    }

    #[tokio::test]
    async fn error_callback_is_not_mistaken_for_an_authorization_code() {
        let (sender, receiver) = oneshot::channel();
        let state = Arc::new(CallbackState {
            expected_state: "expected-fixture".into(),
            sender: Mutex::new(Some(sender)),
        });
        callback(query("expected-fixture", ""), State(state)).await;
        assert!(receiver.await.unwrap().is_err());
    }
}
