-- Migration 010: Performance indexes for frequently-queried columns
-- Add indexes to optimize common query patterns

-- marks table: user_id is queried but not indexed
CREATE INDEX IF NOT EXISTS idx_marks_user_id ON marks(user_id);

-- marks table: composite for user + status queries
CREATE INDEX IF NOT EXISTS idx_marks_user_status ON marks(user_id, status);

-- sessions table: expires_at for cleanup queries
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- sources table: created_by for user-specific queries
CREATE INDEX IF NOT EXISTS idx_sources_created_by ON sources(created_by);

-- sources table: type for filtering
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);

-- user_subscriptions table: user_id for subscription lookups
CREATE INDEX IF NOT EXISTS idx_user_subs_user ON user_subscriptions(user_id);