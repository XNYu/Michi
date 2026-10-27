-- Internal runtime positions are deliberately separate from renderer-owned
-- message metadata and graph synchronization payloads.
CREATE TABLE claude_fork_anchors (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    native_session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    message_role TEXT NOT NULL CHECK (message_role IN ('user', 'assistant')),
    native_message_id TEXT NOT NULL,
    PRIMARY KEY (node_id, native_session_id, message_id)
);
