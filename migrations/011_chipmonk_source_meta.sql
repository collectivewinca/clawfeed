-- Migration 011: Approval workflow for marks
ALTER TABLE marks ADD COLUMN source_name TEXT;
ALTER TABLE marks ADD COLUMN external_id TEXT;
CREATE INDEX IF NOT EXISTS idx_marks_external_id ON marks(external_id);
