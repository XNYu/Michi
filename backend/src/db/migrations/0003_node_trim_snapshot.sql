-- 0003_node_trim_snapshot: support Phase 2 of the trash redesign.
-- Adds an undo-payload column on the nodes table so single-node trim can
-- be reversed cleanly: see services/dbRepository.ts trimNode() for the
-- algorithm. The column is JSON-encoded (TrimSnapshot) and is non-null
-- iff the node is in the trash via single-node trim (not subtree-delete).
--
-- Idempotent: schema_migrations ledger (P0) prevents re-runs.

ALTER TABLE nodes ADD COLUMN trim_snapshot TEXT;
