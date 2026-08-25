CREATE TABLE IF NOT EXISTS harness_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event TEXT NOT NULL,
  source TEXT,
  confidence TEXT,
  native_method TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (node_id, turn_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_harness_events_node_turn
  ON harness_events (node_id, turn_id, seq);
