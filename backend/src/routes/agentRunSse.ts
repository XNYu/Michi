import type { Request, Response } from 'express';
import type { AgentRunDtoV1, AgentRunEventV1, AgentRunSseEnvelopeV1 } from 'michi-shared';
import { AgentRunEventBus } from '../agents/runs/agentRunEventBus';

const MAX_CURSOR_RUNS = 256;
const MAX_REPLAY_EVENTS = 1_000;
const MAX_SSE_BUFFER_BYTES = 1_048_576;

export interface AgentRunSseSource {
  getRun(ownerUserId: string, runId: string): AgentRunDtoV1 | null;
  listEvents(ownerUserId: string, runId: string, afterSeq: number, limit: number): AgentRunEventV1[];
  listRuns(ownerUserId: string, query: { version: 1; workspaceId: string; limit: number }): AgentRunDtoV1[];
}

export interface AgentRunSseDeps {
  source: AgentRunSseSource;
  events: AgentRunEventBus;
  now?: () => number;
  heartbeatMs?: number;
}

function parseCursors(value: unknown): Map<string, number> {
  if (typeof value !== 'string' || !value.trim()) return new Map();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('cursors must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('cursors must be an object');
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > MAX_CURSOR_RUNS) throw new Error(`cursors must contain at most ${MAX_CURSOR_RUNS} Runs`);
  const cursors = new Map<string, number>();
  for (const [runId, seq] of entries) {
    if (!runId.trim() || runId.length > 256 || !Number.isSafeInteger(seq) || (seq as number) < -1) throw new Error('cursors contain an invalid Run sequence');
    cursors.set(runId, seq as number);
  }
  return cursors;
}

function frame(envelope: AgentRunSseEnvelopeV1): string {
  return `event: ${envelope.event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export function createAgentRunSseHandler(deps: AgentRunSseDeps) {
  const now = deps.now ?? Date.now;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  return (req: Request, res: Response): void => {
    const ownerUserId = req.user?.id;
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
    if (!ownerUserId || !workspaceId) { res.status(400).json({ error: 'workspaceId is required' }); return; }
    let cursors: Map<string, number>;
    try { cursors = parseCursors(req.query.cursors); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'invalid cursors' }); return; }
    try { deps.source.listRuns(ownerUserId, { version: 1, workspaceId, limit: 1 }); }
    catch { res.status(404).json({ error: 'not_found' }); return; }
    for (const runId of cursors.keys()) {
      const run = deps.source.getRun(ownerUserId, runId);
      if (!run || run.workspaceId !== workspaceId) { res.status(404).json({ error: 'not_found' }); return; }
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    let closed = false;
    const send = (envelope: AgentRunSseEnvelopeV1): void => {
      if (closed || res.destroyed || res.writableEnded) return;
      if (res.writableLength > MAX_SSE_BUFFER_BYTES) { res.destroy(new Error('Agent Run SSE client exceeded buffer limit')); return; }
      res.write(frame(envelope));
    };

    for (const [runId, afterSeq] of cursors) {
      const run = deps.source.getRun(ownerUserId, runId)!;
      if (afterSeq > run.latestEventSeq) {
        send({ version: 1, event: 'agent_run_gap', runId, seq: null, eventData: null, gapAfterSeq: afterSeq, emittedAt: now() });
        cursors.set(runId, run.latestEventSeq);
        continue;
      }
      const events = deps.source.listEvents(ownerUserId, runId, afterSeq, MAX_REPLAY_EVENTS);
      for (const event of events) {
        send({ version: 1, event: 'agent_run_event', runId, seq: event.seq, eventData: event, gapAfterSeq: null, emittedAt: now() });
        cursors.set(runId, event.seq);
      }
      if ((events.at(-1)?.seq ?? afterSeq) < run.latestEventSeq) {
        send({ version: 1, event: 'agent_run_gap', runId, seq: null, eventData: null, gapAfterSeq: events.at(-1)?.seq ?? afterSeq, emittedAt: now() });
        cursors.set(runId, run.latestEventSeq);
      }
    }

    const unsubscribe = deps.events.subscribeAll((event) => {
      const run = deps.source.getRun(ownerUserId, event.runId);
      if (!run || run.workspaceId !== workspaceId) return;
      const cursor = cursors.get(event.runId) ?? -1;
      if (event.seq <= cursor) return;
      if (event.seq !== cursor + 1) {
        send({ version: 1, event: 'agent_run_gap', runId: event.runId, seq: null, eventData: null, gapAfterSeq: cursor, emittedAt: now() });
        cursors.set(event.runId, event.seq);
      } else {
        send({ version: 1, event: 'agent_run_event', runId: event.runId, seq: event.seq, eventData: event, gapAfterSeq: null, emittedAt: now() });
        cursors.set(event.runId, event.seq);
      }
    });
    const heartbeat = setInterval(() => send({ version: 1, event: 'heartbeat', runId: null, seq: null, eventData: null, gapAfterSeq: null, emittedAt: now() }), heartbeatMs);
    const close = (): void => { if (closed) return; closed = true; clearInterval(heartbeat); unsubscribe(); };
    res.on('close', close);
    res.on('error', close);
  };
}
