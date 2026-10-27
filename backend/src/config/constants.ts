// Owned by the runtime package (EventQueue heartbeats); re-exported for app code.
export { HEARTBEAT_INTERVAL_MS } from 'michi-runtime/internal/core/constants';

/**
 * After cancel is requested, if the streaming generator has not ended within
 * this deadline the turn is force-finished. This prevents cancel from hanging
 * indefinitely when a runtime (especially remote Kiro) ignores the signal.
 */
export const CANCEL_TIMEOUT_MS = 30_000;
