-- 0038_meta_agent_runtime: the Meta agent settings record decides the runtime
-- of every Space maintenance run and of the assistant conversation, resolved
-- when a run starts (services/metaAgent/settings.ts).
--
-- Space maintenance: a workspace config and its managed job no longer carry a
-- runtime profile of their own. Existing copies are cleared, so each workspace
-- follows the Meta agent record (which follows the global settings by
-- default). Revisions are left alone: pending plans keep their authority.

UPDATE scheduled_jobs SET runtime_id = NULL, provider_id = NULL, model_id = NULL, reasoning = NULL
 WHERE id IN (SELECT job_id FROM page_maintenance_configs);
UPDATE page_maintenance_configs SET runtime_id = NULL, provider_id = NULL, model_id = NULL, reasoning = NULL;

-- assistant_runtime_switches: the assistant keeps its conversation when its
-- runtime changes; the next message opens a new native session on the new
-- runtime. The trigger records each such switch where it lands, after the
-- conversation's last message, whichever connection (main thread or DB
-- worker) writes the new binding, so the conversation can show
-- "From here on: <runtime>". It only inserts into its own table, so it cannot
-- fail a node write.

CREATE TABLE IF NOT EXISTS assistant_runtime_switches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  after_message_id TEXT NOT NULL,
  previous_runtime_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  switched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_runtime_switches_node ON assistant_runtime_switches(node_id, id);

CREATE TRIGGER IF NOT EXISTS assistant_runtime_switches_au_v1 AFTER UPDATE OF runtime_id ON nodes
WHEN old.runtime_id IS NOT NULL AND new.runtime_id IS NOT NULL AND old.runtime_id <> new.runtime_id
 AND (SELECT (CASE WHEN json_valid(settings) THEN json_extract(settings, '$.system') END) = 'assistant'
        FROM workspaces WHERE id = new.workspace_id)
BEGIN
  INSERT INTO assistant_runtime_switches (node_id, after_message_id, previous_runtime_id, runtime_id, switched_at)
    SELECT new.id, m.id, old.runtime_id, new.runtime_id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      FROM messages m
     WHERE m.node_id = new.id
     ORDER BY m.seq DESC
     LIMIT 1;
END;
