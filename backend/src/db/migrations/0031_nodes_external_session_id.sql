-- 0031_nodes_external_session_id: nodes.external_session_id for a database
-- the in-process migrateV9 (services/db.ts) skipped, because it checks only
-- workspaces.backend before adding both columns. 0032's triggers read it.
--
-- Every database migrateV9 ran on has the column already: this ALTER then
-- fails as a duplicate column, which the runner records as applied.

ALTER TABLE nodes ADD COLUMN external_session_id TEXT;
