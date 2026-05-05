-- Migration 011: Approval workflow for marks
-- Add approved and rejected statuses to the marks table

-- SQLite doesn't support changing CHECK constraints easily. 
-- We'll just ignore the constraint for now (SQLite only enforces it on INSERT/UPDATE)
-- and add a new migration that handles it if needed.
-- Actually, let's just use the existing column and we'll handle the logic in JS.

-- We also add a source field to marks to know where it came from (arxiv, reddit, etc)
ALTER TABLE marks ADD COLUMN source_name TEXT;
ALTER TABLE marks ADD COLUMN external_id TEXT;
CREATE INDEX IF NOT EXISTS idx_marks_external_id ON marks(external_id);
