-- 0001_workspace_owner: add owner_user_id column to workspaces and create
-- a lookup index. NO backfill — this migration runs unconditionally on
-- every local or desktop runtime, and a blanket UPDATE would
-- mis-stamp other users' workspaces with the dev account's userId.
--
-- In desktop mode (MICHI_CLOUD unset) the column stays NULL
-- and is never read — ownership middleware and dbRepository filters all
-- gate on MICHI_CLOUD === '1'. In cloud mode, saveWorkspace stamps
-- owner_user_id from req.user.id on INSERT (persistence.ts).
--
-- When cloud mode is enabled later, any pre-existing rows with NULL
-- owner_user_id need a one-shot backfill — handle that in a dedicated
-- cloud-gated migration or admin script, NOT here.
--
-- Idempotent: schema_migrations ledger (added in P0) prevents re-runs.
-- NOT NULL is enforced in application code only — SQLite cannot retrofit
-- NOT NULL on an ALTER TABLE ADD COLUMN statement.

ALTER TABLE workspaces ADD COLUMN owner_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);
