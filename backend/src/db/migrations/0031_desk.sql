-- Desk marks sit beside Michi threads. Archiving or ignoring here does not
-- change the conversation, its archive bit, or any message.

CREATE TABLE IF NOT EXISTS desk_thread_marks (
  tree_id          TEXT PRIMARY KEY,
  disposition      TEXT NOT NULL,
  done_by          TEXT,
  marked_at        INTEGER NOT NULL,
  activity_at_mark INTEGER
);

CREATE TABLE IF NOT EXISTS desk_looks (
  owner_key TEXT NOT NULL,
  scope     TEXT NOT NULL,
  looked_at INTEGER NOT NULL,
  PRIMARY KEY (owner_key, scope)
);

CREATE TABLE IF NOT EXISTS desk_receipts (
  id         TEXT PRIMARY KEY,
  owner_key  TEXT NOT NULL,
  action     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  undone_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_desk_receipts_owner ON desk_receipts(owner_key);
