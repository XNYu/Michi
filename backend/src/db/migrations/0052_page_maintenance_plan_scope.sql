-- Preserve existing plans as workspace-scoped, including their receipts/cursors.
-- Separate from 0051 so a duplicate column cannot skip this upgrade.
ALTER TABLE page_maintenance_plans ADD COLUMN scope_space_id TEXT;
