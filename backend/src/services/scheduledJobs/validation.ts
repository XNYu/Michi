import {
  SCHEDULED_JOB_LIMITS,
  isChatPermissionMode,
  type ChatPermissionMode,
  type ScheduledJobSchedule,
  type ScheduledJobSessionMode,
} from 'michi-shared';
import { parseSchedule, ScheduleValidationError } from './schedule';

export class JobValidationError extends Error {}

export interface JobValidationContext {
  now: number;
  defaultSessionMode?: ScheduledJobSessionMode;
  /** True for a live (not trashed/purged) local workspace. */
  workspaceExists(workspaceId: string): boolean;
  runtimeExists(runtimeId: string): boolean;
}

export interface ParsedJobFields {
  workspaceId: string;
  name: string;
  prompt: string;
  schedule: ScheduledJobSchedule;
  runtimeId: string | null;
  providerId: string | null;
  modelId: string | null;
  reasoning: string | null;
  permissionMode: ChatPermissionMode;
  sessionMode: ScheduledJobSessionMode;
  notify: boolean;
  enabled: boolean;
  timeoutSeconds: number;
  conversationUpdates: boolean;
}

export const DEFAULT_JOB_FIELDS = {
  runtimeId: null,
  providerId: null,
  modelId: null,
  reasoning: null,
  permissionMode: 'trust' as ChatPermissionMode,
  sessionMode: 'persistent' as ScheduledJobSessionMode,
  notify: true,
  enabled: true,
  timeoutSeconds: SCHEDULED_JOB_LIMITS.defaultTimeoutSeconds,
  conversationUpdates: false,
};

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new JobValidationError(`${label} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new JobValidationError(`${label} is required`);
  if (trimmed.length > max) throw new JobValidationError(`${label} must be at most ${max} characters`);
  return trimmed;
}

function optionalId(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || /[\0\n\r]/.test(value)) {
    throw new JobValidationError(`${label} is invalid`);
  }
  return value.trim() || null;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new JobValidationError(`${label} must be true or false`);
  return value;
}

type FieldParser = (value: unknown, ctx: JobValidationContext) => unknown;

const PARSERS: { [K in keyof ParsedJobFields]: FieldParser } = {
  workspaceId: (value, ctx) => {
    const id = text(value, 'Workspace', 200);
    if (!ctx.workspaceExists(id)) throw new JobValidationError('Workspace not found');
    return id;
  },
  name: (value) => text(value, 'Name', SCHEDULED_JOB_LIMITS.name),
  prompt: (value) => text(value, 'Prompt', SCHEDULED_JOB_LIMITS.prompt),
  schedule: (value, ctx) => {
    if (value === undefined || value === null) throw new JobValidationError('Schedule is required');
    try {
      return parseSchedule(value, ctx.now, { requireFuture: true });
    } catch (error) {
      throw new JobValidationError(error instanceof ScheduleValidationError ? error.message : 'Invalid schedule');
    }
  },
  runtimeId: (value, ctx) => {
    const id = optionalId(value, 'Agent');
    if (id && !ctx.runtimeExists(id)) throw new JobValidationError(`Agent runtime "${id}" is not available`);
    return id;
  },
  providerId: (value) => optionalId(value, 'Provider'),
  modelId: (value) => optionalId(value, 'Model'),
  reasoning: (value) => optionalId(value, 'Reasoning'),
  permissionMode: (value) => {
    if (!isChatPermissionMode(value)) throw new JobValidationError('Permission mode must be ask, trust or yolo');
    return value;
  },
  sessionMode: (value) => {
    if (value !== 'fresh' && value !== 'persistent') throw new JobValidationError('Thread mode must be fresh or persistent');
    return value;
  },
  notify: (value) => bool(value, 'Notify'),
  enabled: (value) => bool(value, 'Enabled'),
  conversationUpdates: (value) => bool(value, 'Conversation updates'),
  timeoutSeconds: (value) => {
    if (typeof value !== 'number' || !Number.isInteger(value)
      || value < SCHEDULED_JOB_LIMITS.minTimeoutSeconds || value > SCHEDULED_JOB_LIMITS.maxTimeoutSeconds) {
      throw new JobValidationError('Timeout must be between 1 minute and 24 hours');
    }
    return value;
  },
};

const REQUIRED: Array<keyof ParsedJobFields> = ['workspaceId', 'name', 'prompt', 'schedule'];

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JobValidationError('Request body must be an object');
  return raw as Record<string, unknown>;
}

export function parseJobCreate(raw: unknown, ctx: JobValidationContext): ParsedJobFields {
  const body = asObject(raw);
  const parsed: Record<string, unknown> = { ...DEFAULT_JOB_FIELDS, sessionMode: ctx.defaultSessionMode ?? DEFAULT_JOB_FIELDS.sessionMode };
  for (const key of Object.keys(PARSERS) as Array<keyof ParsedJobFields>) {
    // Required fields run their parser on undefined to get its message.
    if (body[key] === undefined && !REQUIRED.includes(key)) continue;
    parsed[key] = PARSERS[key](body[key], ctx);
  }
  return parsed as unknown as ParsedJobFields;
}

/** Only keys present in the body are validated and returned. */
export function parseJobPatch(raw: unknown, ctx: JobValidationContext): Partial<ParsedJobFields> {
  const body = asObject(raw);
  const parsed: Record<string, unknown> = {};
  for (const key of Object.keys(PARSERS) as Array<keyof ParsedJobFields>) {
    if (body[key] === undefined) continue;
    parsed[key] = PARSERS[key](body[key], ctx);
  }
  return parsed as Partial<ParsedJobFields>;
}
