-- 0009_node_last_applied_turn: track the last turn applied to a node.
--
-- The frontend sync payload includes `last_applied_turn_id` so the server
-- can detect which turn's chunks have been applied client-side. Without this
-- column, `saveNode`'s spread parameter bag passes the field to better-sqlite3
-- which rejects unknown named parameters.

ALTER TABLE nodes ADD COLUMN last_applied_turn_id TEXT;
