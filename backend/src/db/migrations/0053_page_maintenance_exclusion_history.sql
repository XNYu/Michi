-- 0035 was already applied on early installations without exclusion history.
CREATE TABLE IF NOT EXISTS page_maintenance_exclusion_periods (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  space_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  after_seq INTEGER NOT NULL CHECK(after_seq >= 0),
  through_seq INTEGER CHECK(through_seq IS NULL OR through_seq >= after_seq),
  excluded_at INTEGER NOT NULL,
  reenabled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_page_maintenance_exclusion_history
  ON page_maintenance_exclusion_periods(workspace_id,owner_user_id,space_id,after_seq,through_seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_maintenance_open_exclusion_period
  ON page_maintenance_exclusion_periods(workspace_id,owner_user_id,space_id) WHERE through_seq IS NULL;

-- Do not invent historical exclusion boundaries or broaden an old unscoped
-- request into a workspace-wide write. Retain the request as cancelled evidence.
UPDATE page_maintenance_catchup_requests
  SET state = 'cancelled'
  WHERE state = 'queued' AND space_id IS NULL;
