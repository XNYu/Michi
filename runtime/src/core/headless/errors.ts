import { ReportedRuntimeError } from '../../contract/errors';
import type { RuntimeErrorCategory } from '../../contract/events';

export type { RuntimeErrorCategory } from '../../contract/events';

export interface ClassifiedRuntimeError {
  category: RuntimeErrorCategory;
  message: string;
  /** Capacity and transient failures may succeed when the work is retried. */
  retryable: boolean;
  /** The runtime's own code for the failure, when its runtime_error event carried one. */
  code?: string;
}

const RETRYABLE: Record<RuntimeErrorCategory, boolean> = {
  auth: false, incompatible: false, capacity: true, transient: true, terminal: false,
};

function isCategory(value: unknown): value is RuntimeErrorCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RETRYABLE, value);
}

function inferredCategory(text: string): RuntimeErrorCategory {
  if (/api.?key|credential|unauthori[sz]ed|forbidden|auth/.test(text)) return 'auth';
  if (/unsupported|not supported|unknown model|invalid model|incompatible/.test(text)) return 'incompatible';
  if (/capacity|concurren|rate.?limit|too many/.test(text)) return 'capacity';
  if (/timeout|timed out|econn|socket|process exited|temporar/.test(text)) return 'transient';
  return 'terminal';
}

/**
 * What the runtime reported wins: a runtime_error event's category and its
 * retryable. Anything it left out, or a category the package does not know,
 * is inferred from the error's name and message. The event's code is passed
 * through and never read as a category.
 */
export function classifyRuntimeError(error: unknown): ClassifiedRuntimeError {
  const message = error instanceof Error ? error.message : String(error);
  const reported = error instanceof ReportedRuntimeError ? error : undefined;
  const code = reported?.code;
  const category = isCategory(reported?.category)
    ? reported.category
    : inferredCategory(`${error instanceof Error ? error.name : ''} ${message}`.toLowerCase());
  return {
    category,
    message,
    retryable: reported?.retryable ?? RETRYABLE[category],
    ...(code !== undefined ? { code } : {}),
  };
}
