/**
 * Scheduled Jobs are a desktop feature: cloud deployments have per-user
 * owners and no local notification path. MICHI_SCHEDULED_JOBS=0 turns them
 * off locally. Read at call time so tests can toggle the environment.
 */
export function scheduledJobsFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MICHI_CLOUD !== '1' && env.MICHI_SCHEDULED_JOBS !== '0';
}
