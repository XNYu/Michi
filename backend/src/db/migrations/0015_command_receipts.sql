CREATE TABLE IF NOT EXISTS command_receipts (
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_command_receipts_created ON command_receipts(created_at);
