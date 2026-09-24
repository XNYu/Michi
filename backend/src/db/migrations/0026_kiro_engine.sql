ALTER TABLE nodes ADD COLUMN runtime_engine TEXT;

CREATE TABLE kiro_fork_anchors (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    native_session_id TEXT NOT NULL,
    engine TEXT NOT NULL CHECK (engine IN ('v2', 'v3')),
    assistant_message_id TEXT NOT NULL,
    user_message_id TEXT,
    log_index INTEGER,
    native_message_id TEXT,
    PRIMARY KEY (node_id, native_session_id, assistant_message_id)
);
