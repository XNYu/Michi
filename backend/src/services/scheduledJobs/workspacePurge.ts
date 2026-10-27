import { getDb } from '../db';

const handlers = new Set<(workspaceId: string) => void>();

/** Scheduler instances synchronously cancel their in-memory handles before workspace rows cascade. */
export function registerScheduledWorkspacePurge(handler: (workspaceId: string) => void): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Permanently remove scheduled work before a workspace purge; safe when no scheduler is running. */
export function purgeScheduledJobsForWorkspace(workspaceId: string): void {
  for (const handler of [...handlers]) handler(workspaceId);
  getDb().prepare('DELETE FROM scheduled_jobs WHERE workspace_id=?').run(workspaceId);
}
