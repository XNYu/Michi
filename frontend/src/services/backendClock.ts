/**
 * Renderer↔backend wall-clock offset, estimated per assistant turn from chat
 * stream frames. Durable timestamps (block and tool `startedAt`) are on the
 * backend's clock; live timers convert renderer "now" through this offset so
 * they stay correct when a remote backend's clock disagrees with this machine.
 *
 * Every ChatHub frame carries `observedAt` (backend clock). A frame received
 * at renderer time r yields the sample r − observedAt = offset + delay, with
 * delay ≥ 0. Live frames arrive with a small delay; frames replayed after a
 * reload or reconnect arrive in one burst and can be seconds stale, and a
 * single sample cannot tell the two apart. The smallest sample seen so far is
 * the candidate; it is trusted only once a frame received at least
 * CONFIRM_GAP_MS after it agrees with it within AGREE_MS. A replay burst
 * cannot confirm itself (it arrives within the gap, and a re-delivered frame
 * drifts by the full gap), while live frames confirm about a second in.
 *
 * The offset is the smallest confirmed sample. Since every sample is at least
 * the true offset, a stale pair that slips through can only make the estimate
 * too large, and the next confirmed live pair lowers it again. Until a sample
 * is confirmed the clocks are assumed to agree, which is exact for the bundled
 * local backend.
 */

const CONFIRM_GAP_MS = 1_000;
const AGREE_MS = 1_000;
/** Turns are short-lived keys; keep only the most recent ones. */
const MAX_TRACKED = 256;

interface ClockState {
  /** Smallest sample seen so far, pending or confirmed. */
  candidate: number;
  /** Renderer time when the candidate frame was received. */
  candidateAt: number;
  /** Smallest confirmed sample. */
  offset?: number;
}

const clocks = new Map<string, ClockState>();

/** Feed one stream frame's backend `observedAt` for `key` (the assistant id). */
export function recordBackendObservation(
  key: string | undefined,
  observedAt: number | undefined,
  receivedAt: number = Date.now(),
): void {
  if (!key || typeof observedAt !== 'number' || !Number.isFinite(observedAt)) return;
  const sample = receivedAt - observedAt;
  const clock = clocks.get(key);
  if (!clock) {
    if (clocks.size >= MAX_TRACKED) {
      const oldest = clocks.keys().next().value;
      if (oldest !== undefined) clocks.delete(oldest);
    }
    clocks.set(key, { candidate: sample, candidateAt: receivedAt });
    return;
  }
  if (receivedAt - clock.candidateAt >= CONFIRM_GAP_MS && Math.abs(sample - clock.candidate) < AGREE_MS) {
    const confirmed = Math.min(sample, clock.candidate);
    clock.offset = clock.offset === undefined ? confirmed : Math.min(clock.offset, confirmed);
  }
  if (sample < clock.candidate) {
    // A much smaller sample means the old candidate was stale (replayed), so
    // it can no longer vouch for the new one: restart the confirmation gap.
    // A small refinement is the same estimate and keeps its receive time.
    if (clock.candidate - sample >= AGREE_MS) clock.candidateAt = receivedAt;
    clock.candidate = sample;
  }
}

/** Current time on the backend clock for `key`; renderer time when unconfirmed. */
export function backendNow(key: string | undefined, now: number = Date.now()): number {
  const offset = key ? clocks.get(key)?.offset : undefined;
  return offset === undefined ? now : now - offset;
}

/** @internal Test isolation only. */
export function resetBackendClocksForTest(): void {
  clocks.clear();
}
