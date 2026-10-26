use super::*;
use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
use sqlx::PgPool;

#[tokio::test]
#[ignore = "requires Postgres"]
async fn create_only_parameterized_replacement_preserves_the_head_and_allows_exact_replay() {
    let pool = PgPool::connect(&crate::test_support::database_url())
        .await
        .unwrap();
    let db = Db::from_pool(pool);
    let community = CommunityId::from_uuid(Uuid::new_v4());
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(community.as_uuid())
        .bind(format!(
            "meeting-precondition-{}.example",
            community.as_uuid()
        ))
        .execute(&db.pool)
        .await
        .unwrap();
    let keys = Keys::generate();
    let identifier = format!("create-only-{}", Uuid::new_v4());
    let timestamp = Timestamp::now().as_secs();
    let event = |content: &str, created_at: u64| {
        EventBuilder::new(Kind::Custom(buzz_core::kind::KIND_PROJECT as u16), content)
            .tags([Tag::parse(["d", &identifier]).unwrap()])
            .custom_created_at(Timestamp::from(created_at))
            .sign_with_keys(&keys)
            .unwrap()
    };
    let initial = event("first", timestamp);
    for (candidate, expected) in [
        (initial.clone(), ParameterizedReplaceStatus::Inserted),
        (
            event("must not overwrite", timestamp + 1),
            ParameterizedReplaceStatus::RevisionMismatch,
        ),
        (initial, ParameterizedReplaceStatus::Duplicate),
    ] {
        let mut transaction = db.begin_event_write_transaction(community).await.unwrap();
        let result = db
            .replace_parameterized_event_in_transaction(
                &mut transaction,
                &candidate,
                &identifier,
                None,
                ParameterizedReplacePrecondition::ExpectNoHead,
            )
            .await
            .unwrap();
        assert_eq!(result.status, expected);
        if expected == ParameterizedReplaceStatus::Inserted {
            transaction.commit().await.unwrap();
        } else {
            transaction.rollback().await.unwrap();
        }
    }
}
