-- Untrusted content a chat turn consumed (services/turnTrust.ts): web pages,
-- shell output, other MCP servers' results. One row per distinct source of a
-- turn; a turn without rows consumed none that Michi saw. Rows outlive the
-- turn so later work (memory extraction) can ask about it.
--
-- Not keyed on turns(turn_id): the turn row may be committed by the DB worker
-- thread, and a source must still record. Rows go with their node: a hard
-- delete cascades, and a purge (purged_at, which deletes the node's messages
-- at once) deletes them by the trigger below.
CREATE TABLE IF NOT EXISTS turn_trust (
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  turn_id     TEXT NOT NULL,
  source_key  TEXT NOT NULL,
  tool        TEXT NOT NULL,
  runtime_id  TEXT NOT NULL,
  detail      TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, turn_id, source_key)
);

CREATE TRIGGER IF NOT EXISTS turn_trust_node_purged AFTER UPDATE OF purged_at ON nodes
WHEN new.purged_at IS NOT NULL
BEGIN
  DELETE FROM turn_trust WHERE node_id = new.id;
END;
