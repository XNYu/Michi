import type { ScheduledJobSessionMode } from 'michi-shared';
import { getMichiConfigPaths } from '../configPaths';
import { readJsonConfig, updateJsonConfig } from '../jsonConfigStore';
import { JobValidationError } from './validation';

const { configPath } = getMichiConfigPaths();

export function getScheduledJobSettings(): { sessionMode: ScheduledJobSessionMode } {
  const mode = readJsonConfig(configPath)?.scheduledJobs?.sessionMode;
  return { sessionMode: mode === 'fresh' ? 'fresh' : 'persistent' };
}

export function updateScheduledJobSettings(raw: unknown): { sessionMode: ScheduledJobSessionMode } {
  const mode = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).sessionMode : undefined;
  if (mode !== 'fresh' && mode !== 'persistent') {
    throw new JobValidationError('Thread mode must be fresh or persistent');
  }
  updateJsonConfig(configPath, (existing) => ({
    ...existing, scheduledJobs: { ...existing.scheduledJobs, sessionMode: mode },
  }));
  return { sessionMode: mode };
}
