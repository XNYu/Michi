-- 0032_assistant_sessions: what Michi's Desk proxy needs to recognise the
-- Michi assistant's own conversations (desk/assistantThreads.ts).
--
-- assistant_native_sessions: every native session id (Claude session, Codex
-- thread) the assistant has run on, current and past. A node keeps only its
-- current binding, and a reload without native resume, a fork or a runtime
-- switch moves it, so the triggers record each id as it is written, whichever
-- connection (main thread or DB worker) writes it. They only insert into
-- their own table and ignore duplicates, so they cannot fail a node write. A
-- workspace is the assistant's when settings.system is 'assistant'; the store
-- marks it before it creates any node in it. The backfill picks up bindings
-- written before this migration.
--
-- assistant_desk_threads: Agent Desk threads once seen carrying one of those
-- conversations. Desk drops a thread's conversation once its progress is no
-- longer live, and nothing else Desk answers ties the thread to it.

CREATE TABLE IF NOT EXISTS assistant_native_sessions (
  native_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS assistant_native_sessions_ai_v1 AFTER INSERT ON nodes
WHEN (SELECT (CASE WHEN json_valid(settings) THEN json_extract(settings, '$.system') END) = 'assistant'
        FROM workspaces WHERE id = new.workspace_id)
BEGIN
  INSERT OR IGNORE INTO assistant_native_sessions (native_id, node_id, recorded_at)
    SELECT new.acp_session_id, new.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE new.acp_session_id IS NOT NULL AND new.acp_session_id <> '' AND new.acp_session_id <> new.id;
  INSERT OR IGNORE INTO assistant_native_sessions (native_id, node_id, recorded_at)
    SELECT new.external_session_id, new.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE new.external_session_id IS NOT NULL AND new.external_session_id <> '' AND new.external_session_id <> new.id;
END;

CREATE TRIGGER IF NOT EXISTS assistant_native_sessions_au_v1 AFTER UPDATE OF acp_session_id, external_session_id ON nodes
WHEN (SELECT (CASE WHEN json_valid(settings) THEN json_extract(settings, '$.system') END) = 'assistant'
        FROM workspaces WHERE id = new.workspace_id)
BEGIN
  INSERT OR IGNORE INTO assistant_native_sessions (native_id, node_id, recorded_at)
    SELECT new.acp_session_id, new.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE new.acp_session_id IS NOT NULL AND new.acp_session_id <> '' AND new.acp_session_id <> new.id;
  INSERT OR IGNORE INTO assistant_native_sessions (native_id, node_id, recorded_at)
    SELECT new.external_session_id, new.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
     WHERE new.external_session_id IS NOT NULL AND new.external_session_id <> '' AND new.external_session_id <> new.id;
END;

INSERT OR IGNORE INTO assistant_native_sessions (native_id, node_id, recorded_at)
  SELECT n.acp_session_id, n.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM nodes n JOIN workspaces w ON w.id = n.workspace_id
   WHERE (CASE WHEN json_valid(w.settings) THEN json_extract(w.settings, '$.system') END) = 'assistant'
     AND n.acp_session_id IS NOT NULL AND n.acp_session_id <> '' AND n.acp_session_id <> n.id;

INSERT OR IGNORE INTO assistant_native_sessions (native_id, node_id, recorded_at)
  SELECT n.external_session_id, n.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM nodes n JOIN workspaces w ON w.id = n.workspace_id
   WHERE (CASE WHEN json_valid(w.settings) THEN json_extract(w.settings, '$.system') END) = 'assistant'
     AND n.external_session_id IS NOT NULL AND n.external_session_id <> '' AND n.external_session_id <> n.id;

CREATE TABLE IF NOT EXISTS assistant_desk_threads (
  thread_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
);
