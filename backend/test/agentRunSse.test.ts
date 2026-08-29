import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { AgentRunEventType, AgentRunStatus, type AgentRunDtoV1, type AgentRunEventV1 } from 'michi-shared';
import { AgentRunEventBus } from '../src/agents/runs/agentRunEventBus';
import { setupAgentRunRoutes, type AgentRunRouteService } from '../src/routes/agentRuns';

const HASH = 'd'.repeat(64);
const run: AgentRunDtoV1 = { version: 1, id: 'run-1', ownerUserId: 'owner-a', workspaceId: 'ws-a', definitionId: null, definitionRevision: null, effectiveDefinition: { version: 1, name: 'Worker', description: 'Works', instructions: 'Work', runtimeProfile: { version: 1, runtimeId: 'pi' }, fallbackChain: [], capabilitySnapshot: { version: 1, entries: [] }, permissionPolicy: { version: 1, preset: 'research', categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 1000, maxAttempts: 1 }, contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 100 } }, invocationMode: 'manual' as any, completionMode: 'detach' as any, parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null, task: 'Work', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null, executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: 'ws-a', snapshotHash: HASH, createdAt: 1 }, status: AgentRunStatus.Running, waitingReason: null, activeAttemptId: null, resultBundle: null, latestEventSeq: 1, createdAt: 1, startedAt: 1, completedAt: null, archivedAt: null, expiresAt: null };
const history: AgentRunEventV1[] = [0, 1].map((seq) => ({ version: 1, runId: 'run-1', seq, attemptId: null, type: AgentRunEventType.Assistant, payload: { text: String(seq) }, createdAt: seq + 1 }));
let server: ReturnType<typeof express.application.listen>;
let base = '';
afterEach(async () => { delete process.env.MICHI_CLOUD; if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

function start(events: AgentRunEventBus) {
  process.env.MICHI_CLOUD = '1';
  const service = { async spawn() { throw new Error('unused'); }, list() { return []; }, getDetail() { return null; }, events() { return null; }, async input() { return false; }, async cancel() { return false; }, async respond() { return null; }, createWatch() { throw new Error('unused'); }, updateWatch() { return null; } } satisfies AgentRunRouteService;
  const source = { getRun(owner: string, id: string) { return owner === 'owner-a' && id === 'run-1' ? run : null; }, listEvents(_owner: string, _id: string, afterSeq: number, limit: number) { return history.filter((event) => event.seq > afterSeq).slice(0, limit); }, listRuns(owner: string, query: { workspaceId: string }) { if (owner !== 'owner-a' || query.workspaceId !== 'ws-a') throw new Error('workspace not found'); return [run]; } };
  const app = express(); app.use((req: any, _res, next) => { const owner = req.header('x-user'); if (owner) req.user = { id: owner }; next(); });
  app.use('/api', setupAgentRunRoutes({ service, sse: { source, events, heartbeatMs: 60_000, now: () => 100 } }));
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<any> {
  let text = '';
  while (!text.includes('\n\n')) { const next = await reader.read(); if (next.done) throw new Error('SSE closed'); text += new TextDecoder().decode(next.value); }
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(data!.slice(6));
}

describe('Agent Run SSE', () => {
  test('replays after per-Run cursor, dedupes, and observes later committed events', async () => {
    const events = new AgentRunEventBus(); start(events);
    const response = await fetch(`${base}/agent-runs/subscribe?workspaceId=ws-a&cursors=${encodeURIComponent(JSON.stringify({ 'run-1': 0 }))}`, { headers: { 'x-user': 'owner-a' } });
    assert.equal(response.status, 200); const reader = response.body!.getReader();
    assert.equal((await readFrame(reader)).seq, 1);
    events.publishCommitted({ ...history[1], seq: 1 });
    events.publishCommitted({ ...history[1], seq: 2, createdAt: 3 });
    assert.equal((await readFrame(reader)).seq, 2);
    await reader.cancel();
  });

  test('reports durable cursor gaps and hides wrong-owner subscriptions', async () => {
    const events = new AgentRunEventBus(); start(events);
    const gap = await fetch(`${base}/agent-runs/subscribe?workspaceId=ws-a&cursors=${encodeURIComponent(JSON.stringify({ 'run-1': 9 }))}`, { headers: { 'x-user': 'owner-a' } });
    const reader = gap.body!.getReader(); const envelope = await readFrame(reader); assert.equal(envelope.event, 'agent_run_gap'); await reader.cancel();
    const hidden = await fetch(`${base}/agent-runs/subscribe?workspaceId=ws-a&cursors=${encodeURIComponent(JSON.stringify({ 'run-1': 0 }))}`, { headers: { 'x-user': 'owner-b' } });
    assert.equal(hidden.status, 404);
  });
});
