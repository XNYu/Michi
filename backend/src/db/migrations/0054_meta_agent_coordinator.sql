-- Maintenance retains its execution identity for receipts, plans and fenced
-- claims, but is no longer an ordinary prompt job with a recurring schedule.
ALTER TABLE scheduled_jobs ADD COLUMN execution_kind TEXT NOT NULL DEFAULT 'scheduled'
  CHECK(execution_kind IN ('scheduled','maintenance'));
UPDATE scheduled_jobs SET execution_kind='maintenance',next_run_at=NULL,
  owner_user_id=(SELECT c.owner_user_id FROM page_maintenance_configs c WHERE c.job_id=scheduled_jobs.id)
  WHERE id IN (SELECT job_id FROM page_maintenance_configs);

CREATE TABLE meta_agent_maintenance_state (
  owner_user_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)),
  last_checked_at INTEGER,
  check_day_start INTEGER,
  check_count INTEGER NOT NULL DEFAULT 0
);
