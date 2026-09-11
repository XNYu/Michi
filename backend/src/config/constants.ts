export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * After cancel is requested, if the streaming generator has not ended within
 * this deadline the turn is force-finished. This prevents cancel from hanging
 * indefinitely when a runtime (especially remote Kiro) ignores the signal.
 */
export const CANCEL_TIMEOUT_MS = 30_000;
