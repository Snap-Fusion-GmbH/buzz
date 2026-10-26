use super::*;
use crate::{DbConfig, DbError};

async fn fixture() -> (Db, CommunityId, [Vec<u8>; 2]) {
    let db = Db::new(&DbConfig {
        database_url: crate::test_support::database_url(),
        ..DbConfig::default()
    })
    .await
    .expect("connect test database");
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(id)
        .bind(format!("deleted-dm-{id}.example"))
        .execute(&db.pool)
        .await
        .expect("create community");
    (db, CommunityId::from_uuid(id), [vec![1; 32], vec![2; 32]])
}

async fn deleted_dm(db: &Db, community: CommunityId, keys: &[Vec<u8>; 2]) -> Uuid {
    let (channel, created) = db
        .open_dm(community, &[&keys[1]], &keys[0])
        .await
        .expect("open original DM");
    assert!(created);
    sqlx::query("UPDATE channels SET canvas = 'retained original content' WHERE community_id = $1 AND id = $2")
        .bind(community.as_uuid())
        .bind(channel.id)
        .execute(&db.pool)
        .await
        .expect("set original content");
    assert!(db
        .soft_delete_channel(community, channel.id)
        .await
        .expect("soft-delete original DM"));
    channel.id
}

async fn assert_reopen(db: &Db, community: CommunityId, keys: &[Vec<u8>; 2], old_id: Uuid) {
    let (replacement, created) = db
        .open_dm(community, &[&keys[1]], &keys[0])
        .await
        .expect("deleted DM must not block reopening");
    assert!(created);
    assert_ne!(replacement.id, old_id);
    let original: (bool, String) = sqlx::query_as(
        "SELECT deleted_at IS NOT NULL, canvas FROM channels WHERE community_id = $1 AND id = $2",
    )
    .bind(community.as_uuid())
    .bind(old_id)
    .fetch_one(&db.pool)
    .await
    .expect("read retained original");
    assert_eq!(original, (true, "retained original content".to_owned()));

    for key in keys {
        let dms = db
            .list_dms_for_user(community, key, 20, None)
            .await
            .expect("list participant DMs");
        assert_eq!(dms.len(), 1);
        assert_eq!(dms[0].channel_id, replacement.id);
        assert_eq!(dms[0].participants.len(), 2);
    }

    db.hide_dm(community, replacement.id, &keys[1])
        .await
        .expect("hide replacement for other participant");
    let (same, created) = db
        .open_dm(community, &[&keys[0]], &keys[1])
        .await
        .expect("reopen existing DM from other participant");
    assert!(!created);
    assert_eq!(same.id, replacement.id);
    assert!(db
        .list_hidden_dms(community, &keys[1])
        .await
        .expect("list hidden DMs")
        .is_empty());

    let hash = compute_participant_hash(&[&keys[0], &keys[1]]);
    let duplicate = sqlx::query(
        "INSERT INTO channels (community_id, id, name, channel_type, visibility, created_by, participant_hash) \
         VALUES ($1, $2, 'duplicate DM', 'dm', 'private', $3, $4)",
    )
    .bind(community.as_uuid())
    .bind(Uuid::new_v4())
    .bind(&keys[0])
    .bind(hash.as_slice())
    .execute(&db.pool)
    .await
    .expect_err("active participant sets must remain unique");
    assert_eq!(
        duplicate.as_database_error().and_then(|e| e.constraint()),
        Some("idx_channels_dm_hash")
    );

    let other_id = Uuid::new_v4();
    sqlx::query("INSERT INTO communities (id, host) VALUES ($1, $2)")
        .bind(other_id)
        .bind(format!("other-dm-{other_id}.example"))
        .execute(&db.pool)
        .await
        .expect("create other community");
    let (other, created) = db
        .open_dm(CommunityId::from_uuid(other_id), &[&keys[1]], &keys[0])
        .await
        .expect("same participants may open a DM in another community");
    assert!(created);
    assert_ne!(other.id, replacement.id);
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn deleted_dm_does_not_block_reopening() {
    let (db, community, keys) = fixture().await;
    let old_id = deleted_dm(&db, community, &keys).await;
    assert_reopen(&db, community, &keys, old_id).await;
}

#[tokio::test]
#[ignore = "requires Postgres"]
async fn migration_schema_deleted_dm_releases_participant_hash() {
    let pool = PgPool::connect(&crate::test_support::database_url())
        .await
        .expect("connect empty database");
    crate::migration::run_migrations_through(&pool, 66)
        .await
        .expect("apply migrations preceding DM uniqueness fix");
    let (db, community, keys) = fixture().await;
    let old_id = deleted_dm(&db, community, &keys).await;
    let error = db
        .open_dm(community, &[&keys[1]], &keys[0])
        .await
        .expect_err("old index reproduces the production failure");
    assert!(
        matches!(error, DbError::Sqlx(ref e) if e.as_database_error().and_then(|e| e.constraint()) == Some("idx_channels_dm_hash")),
        "expected participant-hash conflict, got {error:?}"
    );
    crate::migration::run_migrations(&pool)
        .await
        .expect("apply DM uniqueness fix");
    let applied: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = 67 AND success)",
    )
    .fetch_one(&pool)
    .await
    .expect("read migration state");
    assert!(applied, "DM uniqueness migration must have been applied");
    assert_reopen(&db, community, &keys, old_id).await;
}
