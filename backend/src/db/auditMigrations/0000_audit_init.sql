CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  actor_user_id TEXT,
  actor_email   TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  ip            TEXT,
  ua            TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, ts DESC);
