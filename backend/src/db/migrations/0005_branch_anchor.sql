-- 0005_branch_anchor: persist branch-provenance fields so they survive a
-- save/reload cycle.
--
-- Three new columns:
--   edges.anchor_message_id  TEXT     Id of the parent's message that
--                                     anchored the fork. Null for edges
--                                     created before this migration.
--   edges.created_at         INTEGER  Unix ms when the fork was created.
--                                     Null for pre-migration edges.
--   nodes.follow_ups_source_message_id
--                            TEXT     Id of the assistant message whose
--                                     reply produced the node's current
--                                     followUps[]. Null when followUps
--                                     haven't been set or pre-migration.
--
-- Idempotent: schema_migrations ledger (P0) plus the runner's benign-error
-- swallow guarantee that a re-run on a DB that already has these columns
-- records the migration as applied without failing.

ALTER TABLE edges ADD COLUMN anchor_message_id TEXT;
ALTER TABLE edges ADD COLUMN created_at INTEGER;
ALTER TABLE nodes ADD COLUMN follow_ups_source_message_id TEXT;
