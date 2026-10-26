use super::*;
use axum::{routing::post, Json, Router};
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

async fn reader_fixture(
    response: impl FnOnce(&nostr::Keys, &nostr::Keys) -> Vec<Event>,
    delegated: bool,
) -> (
    BuzzClient,
    String,
    oneshot::Receiver<serde_json::Value>,
    tokio::task::JoinHandle<()>,
) {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let owner_keys = nostr::Keys::generate();
    let keys = nostr::Keys::generate();
    let events = response(&keys, &owner_keys);
    let owner = owner_keys.public_key().to_hex();
    let tag = delegated.then(|| {
        Tag::parse(["auth", owner.as_str(), "fixture"]).expect("synthetic owner attestation")
    });
    let tag_json = tag
        .as_ref()
        .map(|tag| serde_json::to_string(tag.as_slice()).unwrap());
    let (sender, receiver) = oneshot::channel();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let router = Router::new().route(
        "/query",
        post(move |Json(filter): Json<serde_json::Value>| {
            let sender = sender.clone();
            let events = events.clone();
            async move {
                if let Some(sender) = sender.lock().unwrap().take() {
                    let _ = sender.send(filter);
                }
                Json(events)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let client = BuzzClient::new(format!("http://{address}"), keys, tag, tag_json).unwrap();
    (client, owner, receiver, server)
}

#[tokio::test]
async fn default_project_list_queries_the_agent_and_its_attested_owner() {
    let (client, owner, request, server) = reader_fixture(|_, _| vec![], true).await;
    cmd_list(&client, None, Some(7)).await.unwrap();
    let query = tokio::time::timeout(std::time::Duration::from_secs(2), request)
        .await
        .unwrap()
        .unwrap();
    server.abort();
    let query = &query[0];
    assert_eq!(query["kinds"], serde_json::json!([30621]));
    assert_eq!(
        query["authors"],
        serde_json::json!([client.keys().public_key().to_hex(), owner]),
    );
    assert_eq!(query["limit"], 7);
}

fn project_event(keys: &nostr::Keys, slug: &str) -> Event {
    EventBuilder::new(nostr::Kind::Custom(30621), "")
        .tags([
            Tag::parse(["d", slug]).unwrap(),
            Tag::parse(["buzz-visibility", "unlisted"]).unwrap(),
        ])
        .sign_with_keys(keys)
        .unwrap()
}

#[tokio::test]
async fn owner_project_get_resolves_unlisted_but_ambiguous_names_require_an_owner() {
    let (client, owner, _, server) =
        reader_fixture(|_, owner| vec![project_event(owner, "private-demo")], true).await;
    let event = super::reads::fetch_read_project(&client, "private-demo", None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.pubkey.to_hex(), owner);
    server.abort();

    let (client, _, _, server) = reader_fixture(
        |agent, owner| {
            vec![
                project_event(agent, "private-demo"),
                project_event(owner, "private-demo"),
            ]
        },
        true,
    )
    .await;
    let error = super::reads::fetch_read_project(&client, "private-demo", None)
        .await
        .unwrap_err();
    assert!(matches!(error, CliError::Usage(_)));
    server.abort();
}

#[tokio::test]
async fn explicit_owner_and_human_reads_do_not_expand_the_author_scope() {
    for delegated in [false, true] {
        let (client, owner, request, server) = reader_fixture(|_, _| vec![], delegated).await;
        let explicit = delegated.then_some(owner.as_str());
        cmd_list(&client, explicit, None).await.unwrap();
        let query = request.await.unwrap();
        assert_eq!(
            query[0]["authors"],
            serde_json::json!([if delegated {
                owner
            } else {
                client.keys().public_key().to_hex()
            }])
        );
        server.abort();
    }
}

#[tokio::test]
async fn repository_listing_is_owner_aware_but_project_write_lookup_is_still_self_only() {
    let (client, owner, request, server) = reader_fixture(|_, _| vec![], true).await;
    crate::commands::repos::cmd_list_repos(&client, None, None)
        .await
        .unwrap();
    let query = request.await.unwrap();
    assert_eq!(query[0]["kinds"], serde_json::json!([30617]));
    assert_eq!(
        query[0]["authors"],
        serde_json::json!([client.keys().public_key().to_hex(), owner])
    );
    server.abort();

    let (client, _, request, server) = reader_fixture(|_, _| vec![], true).await;
    assert!(fetch_own_project(&client, "private-demo")
        .await
        .unwrap()
        .is_none());
    let query = request.await.unwrap();
    assert_eq!(
        query[0]["authors"],
        serde_json::json!([client.keys().public_key().to_hex()])
    );
    server.abort();
}
