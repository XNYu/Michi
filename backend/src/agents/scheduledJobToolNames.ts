/** Names of the Scheduled Job agent tools; kept dependency-free for the tool catalog. */
export const SCHEDULED_JOB_TOOL_NAMES = [
  "list_scheduled_jobs",
  "create_scheduled_job",
  "update_scheduled_job",
  "run_scheduled_job",
  "delete_scheduled_job",
] as const;

export type ScheduledJobToolName = typeof SCHEDULED_JOB_TOOL_NAMES[number];

export function isScheduledJobToolName(name: string): name is ScheduledJobToolName {
  return (SCHEDULED_JOB_TOOL_NAMES as readonly string[]).includes(name);
}
