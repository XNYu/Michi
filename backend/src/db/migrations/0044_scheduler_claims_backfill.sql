UPDATE scheduler_execution_claims
SET workspace_id = COALESCE(
      (SELECT workspace_id FROM scheduled_job_runs WHERE id = scheduler_execution_claims.run_id),
      (SELECT workspace_id FROM scheduled_jobs WHERE id = scheduler_execution_claims.job_id),
      ''),
    quarantined_at = COALESCE(quarantined_at, acquired_at),
    reason = COALESCE(reason, 'An earlier Michi version did not confirm that this execution stopped')
WHERE workspace_id = '';
