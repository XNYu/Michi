import type { RuntimeErrorCategory } from './events';

/** Only adapters with positive evidence of unavailable native state may throw this. */
export class NativeResumeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NativeResumeUnavailableError';
  }
}

/**
 * The failure a session reported with a runtime_error event, thrown where a
 * host's turn loop stops on it. Keeps the event's code, category and
 * retryable, when the runtime gave them, so the host need not infer them from
 * the message.
 */
export class ReportedRuntimeError extends Error {
  // Declared only: under every target an absent field is not an own property.
  declare readonly code?: string;
  declare readonly category?: RuntimeErrorCategory;
  declare readonly retryable?: boolean;
  constructor(event: { error: string; code?: string; category?: RuntimeErrorCategory; retryable?: boolean }) {
    super(event.error);
    this.name = 'ReportedRuntimeError';
    if (event.code !== undefined) this.code = event.code;
    if (event.category !== undefined) this.category = event.category;
    if (event.retryable !== undefined) this.retryable = event.retryable;
  }
}

export class NativeResumeFailedError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown, message = 'Native session restore could not complete. The original session binding has been retained. Please retry; check the runtime connection and authentication if this persists.') {
    super(message);
    this.name = 'NativeResumeFailedError';
    this.cause = cause;
  }
}
