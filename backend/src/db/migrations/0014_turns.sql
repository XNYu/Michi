CREATE TABLE IF NOT EXISTS turns (
  turn_id              TEXT PRIMARY KEY,
  node_id              TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  user_message_id      TEXT,
  assistant_message_id TEXT NOT NULL,
  status               TEXT NOT NULL,
  last_seq             INTEGER NOT NULL DEFAULT -1,
  stop_reason          TEXT,
  error                TEXT,
  started_at           INTEGER NOT NULL,
  checkpoint_at        INTEGER,
  completed_at         INTEGER,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_node ON turns(node_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_assistant_message ON turns(assistant_message_id);
