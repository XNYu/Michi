-- Serve recent/older display pages without sorting or reading full message bodies.
CREATE INDEX IF NOT EXISTS idx_messages_node_seq_id ON messages(node_id, seq, id);
