-- 0007_workspace_pinned_at: add pinned_at column to workspaces table.
-- The frontend already sends pinned_at on workspace sync but the column
-- only existed on trees (migration V14). This adds it to workspaces so
-- saveWorkspace can persist the value without "Unknown named parameter" errors.

ALTER TABLE workspaces ADD COLUMN pinned_at INTEGER;
