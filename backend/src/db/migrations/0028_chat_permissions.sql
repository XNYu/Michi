ALTER TABLE nodes ADD COLUMN permission_mode TEXT CHECK (permission_mode IN ('ask', 'trust', 'yolo'));
CREATE TABLE chat_permission_grants (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tool_key TEXT NOT NULL,
  PRIMARY KEY (node_id, tool_key)
);
