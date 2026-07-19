-- 0008_context_artifacts: grow `contexts` into the artifact model (3a sidebar).
--
-- A context row is now a typed artifact: doc / file / image / link. Links carry
-- a `url` and no file, so `file_path` is relaxed to allow the empty string
-- (SQLite has no cheap way to drop the NOT NULL constraint, so callers write
-- '' for links; the app treats '' + non-null url as a link).
--
-- New columns (all nullable / defaulted so existing rows migrate cleanly):
--   type              artifact type: 'doc' | 'file' | 'image' | 'link'
--   url               external URL for link artifacts
--   origin_node_id    provenance: node the artifact came from
--   origin_message_id provenance: message the artifact came from
--   kind              'embedded' | 'reference' — previously frontend-only, now
--                     durable so injection resolves correctly after reload
--   pinned_at         UI pin (shelf ordering); independent of the removed
--                     auto-inject flag
--
-- The retired `auto_inject` column is intentionally left in place: SQLite
-- column drops require a full table rebuild, and a stale column is harmless.
--
-- ALTER TABLE ADD COLUMN has no IF NOT EXISTS; the migrate runner swallows the
-- benign "duplicate column name" error so this stays idempotent across DBs that
-- already received a column from a prior deploy.

ALTER TABLE contexts ADD COLUMN type TEXT;
ALTER TABLE contexts ADD COLUMN url TEXT;
ALTER TABLE contexts ADD COLUMN origin_node_id TEXT;
ALTER TABLE contexts ADD COLUMN origin_message_id TEXT;
ALTER TABLE contexts ADD COLUMN kind TEXT;
ALTER TABLE contexts ADD COLUMN pinned_at INTEGER;

-- Backfill type for existing rows: embedded docs → 'doc', references → 'file'.
-- `kind` was frontend-only before this migration so it's absent in the DB;
-- infer from file_path extension where possible, else default to 'doc'.
UPDATE contexts SET type = 'doc' WHERE type IS NULL;
