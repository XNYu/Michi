-- A workspace's task database is a native Pages database with a role. Each
-- owner keeps at most one live task database per workspace.
ALTER TABLE page_databases ADD COLUMN role TEXT CHECK (role IS NULL OR role = 'tasks');
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_databases_task_role
  ON page_databases(owner_user_id, workspace_id) WHERE role = 'tasks' AND deleted_at IS NULL;
