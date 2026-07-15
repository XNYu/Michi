import { Buffer } from 'node:buffer';
import * as perf from '../../services/perf';

export interface ClaudeStdoutProbeDeps {
  enabled: () => boolean;
  now: () => number;
  mark: (stage: string, meta?: Record<string, unknown>) => void;
}

interface ClaudeStdoutProbeContext {
  sessionId: string;
  nodeId: string;
}

const DEFAULT_DEPS: ClaudeStdoutProbeDeps = {
  enabled: perf.enabled,
  now: perf.now,
  mark: perf.mark,
};

/**
 * Adds opt-in timing metadata at the Claude CLI stdout boundary.
 *
 * The disabled path returns the original handler so normal streaming pays no
 * per-chunk clock or allocation cost. Diagnostic marks contain sizes and
 * timing only; model output is never logged.
 */
export function createClaudeStdoutHandler(
  onChunk: (chunk: string) => void,
  context: ClaudeStdoutProbeContext,
  deps: ClaudeStdoutProbeDeps = DEFAULT_DEPS,
): (chunk: string) => void {
  if (!deps.enabled()) return onChunk;

  let previousAt: number | undefined;
  let sequence = 0;

  return (chunk: string) => {
    let meta: Record<string, unknown> | undefined;

    try {
      const receivedAt = deps.now();
      const nextSequence = sequence + 1;
      const gapMs = previousAt === undefined
        ? undefined
        : Number((receivedAt - previousAt).toFixed(1));

      meta = {
        ...context,
        sequence: nextSequence,
        bytes: Buffer.byteLength(chunk),
        lines: chunk.match(/\n/g)?.length ?? 0,
        ...(gapMs === undefined ? {} : { gapMs }),
      };
      previousAt = receivedAt;
      sequence = nextSequence;
    } catch {
      // Observability must never interfere with stdout delivery.
    }

    onChunk(chunk);

    if (!meta) return;
    try {
      deps.mark('claude:stdout_data', meta);
    } catch {
      // A broken diagnostic sink must not escape the stream callback.
    }
  };
}
