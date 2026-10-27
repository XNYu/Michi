ALTER TABLE scheduler_lease ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

-- A terminal run record is not evidence that its executor has stopped. Keep
-- admission reservations separate, including after a job is deleted.
CREATE TABLE scheduler_execution_claims (
  run_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  generation INTEGER NOT NULL,
  process_id INTEGER,
  acquired_at INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  process_exit_safe INTEGER NOT NULL DEFAULT 0,
  quarantined_at INTEGER,
  reason TEXT
);
CREATE INDEX idx_scheduler_execution_claims_job ON scheduler_execution_claims(job_id);

-- Old versions did not persist process identity. Preserve uncertain occupancy
-- rather than allowing an upgrade to overlap an unconfirmed old executor.
INSERT INTO scheduler_execution_claims (run_id, job_id, holder, generation, process_id, acquired_at, workspace_id, quarantined_at, reason)
SELECT id, job_id, claimed_by, 0, NULL, started_at, workspace_id, started_at, 'An earlier Michi version did not confirm that this execution stopped' FROM scheduled_job_runs WHERE status = 'running';
