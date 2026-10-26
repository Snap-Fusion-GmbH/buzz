# Managed fork migration compatibility

The managed fork and upstream allocated migration version 67 independently.
The managed fork already assigned that version to
`0067_live_dm_participant_uniqueness.sql`, so its version and contents must stay
unchanged for existing managed databases.

The October 25, 2026 upstream integration retains upstream migration 68
(`entity_deletion_requests`) and assigns the incoming `channel_join_role`
migration version 69. The latter is independent of migration 68 and remains an
additive, backward-compatible column change. Its SQL is unchanged. The
subsequent integration retains upstream migrations 69 and 70 and moves only
`channel_join_role` to 71 to avoid the duplicate version number.

Managed databases must continue using this fork's migration sequence. Do not
point an upstream binary at a migrated managed database or switch an upstream
database to this fork without reviewing its recorded migration versions and
checksums first. No existing migration records are rewritten by this
integration.

The embedded-migrator regression test checks the retained version 67, versions
68 and 69, and strictly increasing migration versions.
