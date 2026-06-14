-- 0004_tombstones: support Phase 3 of the trash redesign — multi-tab
-- anti-revival via tombstones.
--
-- Two new columns:
--   nodes.purged_at INTEGER       Unix-ms when the node was permanently
--                                 purged. saveNode / saveTree / saveEdge /
--                                 saveMessage refuse to write to ids whose
--                                 tombstone is non-null. Reads filter them
--                                 out so the UI never sees zombie rows.
--   workspaces.purged_at INTEGER  Same, scoped to the whole workspace; a
--                                 stale POST /sync from another tab cannot
--                                 reanimate a tombstoned workspace.
--
-- The tombstones themselves are GC'd lazily by runTombstoneGc() in
-- dbRepository.ts when they exceed TOMBSTONE_TTL_MS (90 days) — long enough
-- to outlast any reasonable offline-tab snapshot age.
--
-- Idempotent: schema_migrations ledger (P0) plus the runner's benign-error
-- swallow guarantee that a re-run on a DB that already has these columns
-- (from the retired inline migrateV16) records the migration as applied
-- without failing.

ALTER TABLE nodes      ADD COLUMN purged_at INTEGER;
ALTER TABLE workspaces ADD COLUMN purged_at INTEGER;
