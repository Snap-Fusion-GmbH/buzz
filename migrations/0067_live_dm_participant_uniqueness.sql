-- Deleted DMs remain retained, but must not reserve their participants' hash:
-- open_dm deliberately creates a new conversation rather than reviving them.
DROP INDEX idx_channels_dm_hash;
CREATE UNIQUE INDEX idx_channels_dm_hash ON channels (community_id, participant_hash)
    WHERE participant_hash IS NOT NULL AND deleted_at IS NULL;
