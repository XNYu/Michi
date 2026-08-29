import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDefinitionDtoV1, AgentRunDtoV1 } from 'michi-shared';
import { AgentDefinitionStatus, AgentRunCompletionMode, AgentRunInvocationMode, AgentRunStatus } from 'michi-shared';
import {
  backendApiBase, indexBackendProjects, setActiveBackendConnectionId,
} from '../config/backendConnections';
import {
  createAgentDefinition, getAgentDefinition, listAgentDefinitions, listAgentRuns, getAgentRun, getAgentRunDetail, getAgentRunEvents,
  sendAgentRunInput, cancelAgentRun, spawnAgentRun, subscribeAgentRuns,
} from './api';

const hash = 'a'.repeat(64);
const effective = { version: 1 as const, name: 'Worker', description: 'Does work.', instructions: 'Do work.', runtimeProfile: { version: 1 as const, runtimeId: 'pi' }, fallbackChain: [], capabilitySnapshot: { version: 1 as const, entries: [] }, permissionPolicy: { version: 1 as const, preset: 'research' as const, categories: {}, maxDelegationDepth: 0, maxConcurrentRuns: 1, maxWallTimeMs: 60_000, maxAttempts: 1 }, contextPolicy: { version: 1 as const, includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: false, allowArtifactContext: false, maxEstimatedChars: 10_000 } };
const definition = (id: string): AgentDefinitionDtoV1 => ({ version: 1, id, ownerUserId: 'owner', scope: 'global', workspaceId: null, name: 'Worker', description: 'Does work.', instructions: 'Do work.', runtimeProfile: effective.runtimeProfile, fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: effective.permissionPolicy, contextPolicy: effective.contextPolicy, defaultRunTtlMs: null, status: AgentDefinitionStatus.Enabled, revision: 1, createdAt: 1, updatedAt: 1 });
const run = (workspaceId = 'remote-ws'): AgentRunDtoV1 => ({ version: 1, id: 'same-run', ownerUserId: 'owner', workspaceId, definitionId: null, definitionRevision: null, effectiveDefinition: effective, invocationMode: AgentRunInvocationMode.Delegated, completionMode: AgentRunCompletionMode.Notify, parentRunId: null, parentNodeId: 'remote-node', parentTurnId: 'turn-1', parentMessageId: 'message-1', parentToolCallId: null, task: 'Task', contextManifest: { version: 1, entries: [], assembledAt: 1, estimatedChars: 0 }, expectedResult: null, executionEnvironment: { version: 1, kind: 'shared_workspace', cwd: '/tmp', sourceWorkspaceId: workspaceId, snapshotHash: hash, createdAt: 1 }, status: AgentRunStatus.Running, waitingReason: null, activeAttemptId: 'attempt-1', resultBundle: null, latestEventSeq: -1, createdAt: 1, startedAt: 1, completedAt: null, archivedAt: null, expiresAt: null });
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('Agent REST/SSE multi-Backend routing', () => {
  beforeEach(() => {
    indexBackendProjects([
      { id: 'remote-ws', backendConnectionId: 'remote-a', chatIds: ['remote-node'] },
      { id: 'other-ws', backendConnectionId: 'remote-b', chatIds: ['other-node'] },
    ]);
    setActiveBackendConnectionId('local');
    vi.restoreAllMocks();
  });

  it('routes Workspace list/spawn/get/input/cancel through the owning proxy', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/agent-runs?')) return json({ runs: [run()] });
      if (url.endsWith('/agent-runs') && init?.method === 'POST') return json({ run: run() });
      if (url.endsWith('/input') || url.endsWith('/cancel')) return new Response(null, { status: 204 });
      return json({ run: run() });
    }));
    const listed = await listAgentRuns({ version: 1, workspaceId: 'remote-ws' });
    const spawned = await spawnAgentRun({ version: 1, workspaceId: 'remote-ws', agentId: 'agent-1', ephemeralDefinition: null, task: 'Task', contextManifest: run().contextManifest, permissionRestriction: null, environment: { version: 1, kind: 'auto' }, expectedResult: null, completionMode: AgentRunCompletionMode.Notify, invocationMode: AgentRunInvocationMode.Delegated, runTtlMs: null, parentRunId: null, parentNodeId: 'remote-node', parentTurnId: 'turn-1', parentMessageId: 'message-1', parentToolCallId: null });
    const identity = { backendConnectionId: 'remote-a', id: 'same-run' };
    await getAgentRun(identity);
    await sendAgentRunInput({ identity, workspaceId: 'remote-ws', parentNodeId: 'remote-node' }, { version: 1, text: 'continue', mode: 'queued', expectedAttemptId: 'attempt-1' });
    await cancelAgentRun({ identity, workspaceId: 'remote-ws', parentNodeId: 'remote-node' }, { version: 1, expectedAttemptId: 'attempt-1', reason: null });
    expect(listed[0].backendConnectionId).toBe('remote-a');
    expect(spawned.backendConnectionId).toBe('remote-a');
    expect(calls.every((call) => call.url.startsWith(backendApiBase('remote-a')))).toBe(true);
  });

  it('uses the composite Run identity for mutations even when an equal-ID Parent points at another Backend', async () => {
    indexBackendProjects([
      { id: 'local-ws', chatIds: ['local-parent'] },
      { id: 'remote-ws', backendConnectionId: 'remote-a', chatIds: ['remote-parent'] },
    ]);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, { status: 204 });
    }));
    await sendAgentRunInput({
      identity: { backendConnectionId: 'remote-a', id: 'same-run' },
      workspaceId: 'remote-ws', parentNodeId: 'local-parent',
    }, { version: 1, text: 'remote input', mode: 'queued', expectedAttemptId: null });
    await cancelAgentRun({
      identity: { backendConnectionId: 'local', id: 'same-run' },
      workspaceId: 'local-ws', parentNodeId: 'remote-parent',
    }, { version: 1, expectedAttemptId: null, reason: null });
    expect(calls[0].startsWith(backendApiBase('remote-a'))).toBe(true);
    expect(calls[1].startsWith(backendApiBase('local'))).toBe(true);
  });

  it('routes spawn by the Workspace Backend and rejects a Parent from another Backend', async () => {
    indexBackendProjects([
      { id: 'remote-ws', backendConnectionId: 'remote-a', chatIds: ['remote-parent'] },
      { id: 'other-ws', backendConnectionId: 'remote-b', chatIds: ['other-parent'] },
    ]);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(spawnAgentRun({
      version: 1, workspaceId: 'remote-ws', agentId: 'same-agent', ephemeralDefinition: null,
      task: 'Task', contextManifest: run().contextManifest, permissionRestriction: null,
      environment: { version: 1, kind: 'auto' }, expectedResult: null,
      completionMode: AgentRunCompletionMode.Notify, invocationMode: AgentRunInvocationMode.Delegated,
      runTtlMs: null, parentRunId: null, parentNodeId: 'other-parent', parentTurnId: 'turn-1',
      parentMessageId: 'message-1', parentToolCallId: null,
    })).rejects.toThrow(/different Backend/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('captures the active Backend for Global results and later actions do not drift', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return calls.length === 1 ? json({ definitions: [definition('same-agent')] }) : json({ definition: definition('same-agent') });
    }));
    setActiveBackendConnectionId('remote-a');
    const [located] = await listAgentDefinitions();
    setActiveBackendConnectionId('remote-b');
    await getAgentDefinition({ backendConnectionId: located.backendConnectionId, id: located.value.id });
    expect(located.backendConnectionId).toBe('remote-a');
    expect(calls[0].startsWith(backendApiBase('remote-a'))).toBe(true);
    expect(calls[1].startsWith(backendApiBase('remote-a'))).toBe(true);
  });

  it('can pin Global creation to the Library control plane captured by its route', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); return json({ definition: definition('global-created') }); }));
    setActiveBackendConnectionId('remote-b');
    await createAgentDefinition({ version: 1, scope: 'global', workspaceId: null, name: 'Worker', description: 'Does work.', instructions: 'Do work.', runtimeProfile: effective.runtimeProfile, fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: effective.permissionPolicy, contextPolicy: effective.contextPolicy, defaultRunTtlMs: null }, undefined, 'remote-a');
    expect(calls[0].startsWith(backendApiBase('remote-a'))).toBe(true);
  });

  it('validates Attempt and Interaction records in Run detail responses', async () => {
    const attempt = { version: 1, id: 'attempt-1', runId: 'same-run', attemptIndex: 0, profileIndex: 0, runtimeProfile: effective.runtimeProfile, status: 'running', publicSessionId: 'session-1', recoveryEnvelope: null, startedAt: 1, checkpointAt: null, completedAt: null, error: null };
    const interaction = { version: 1, id: 'interaction-1', runId: 'same-run', attemptId: 'attempt-1', kind: 'user_input', status: 'pending', request: { prompt: 'Choose' }, response: null, createdAt: 1, resolvedAt: null };
    vi.stubGlobal('fetch', vi.fn(async () => json({ run: run(), attempts: [attempt], events: [], interactions: [interaction] })));
    const detail = await getAgentRunDetail({ backendConnectionId: 'remote-a', id: 'same-run' });
    expect(detail.value.attempts).toEqual([attempt]);
    expect(detail.value.interactions).toEqual([interaction]);

    vi.stubGlobal('fetch', vi.fn(async () => json({ run: run(), attempts: [{ ...attempt, publicSessionId: '' }], events: [], interactions: [] })));
    await expect(getAgentRunDetail({ backendConnectionId: 'remote-a', id: 'same-run' })).rejects.toThrow(/publicSessionId/);
  });

  it('parses ordered SSE, reports wrong versions, and unsubscribe never posts cancel', async () => {
    const event = { version: 1, runId: 'same-run', seq: 0, attemptId: 'attempt-1', type: 'assistant', payload: { text: 'done' }, createdAt: 2 };
    const frames = [
      `event: agent_run_event\ndata: ${JSON.stringify({ version: 1, event: 'agent_run_event', runId: 'same-run', seq: 0, eventData: event, gapAfterSeq: null, emittedAt: 3 })}\n\n`,
      `event: agent_run_event\ndata: ${JSON.stringify({ version: 2 })}\n\n`,
    ].join('');
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(frames)); controller.close(); } }), { status: 200 });
    }));
    const envelopes: number[] = [];
    const malformed: Error[] = [];
    await new Promise<void>((resolve) => {
      subscribeAgentRuns('remote-ws', { cursors: { 'same-run': -1 }, onEnvelope: (envelope) => { if (envelope.seq !== null) envelopes.push(envelope.seq); }, onMalformed: (error) => malformed.push(error), onDisconnect: () => resolve() });
    });
    const unsubscribe = subscribeAgentRuns('remote-ws', { onEnvelope: () => {} });
    unsubscribe();
    expect(envelopes).toEqual([0]);
    expect(malformed).toHaveLength(1);
    expect(calls[0].url.startsWith(backendApiBase('remote-a'))).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/cancel'))).toBe(false);
  });

  it('paginates authoritative event replay until the Run feed is complete', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      const after = Number(new URL(url).searchParams.get('afterSeq'));
      const start = after + 1; const count = after < 0 ? 1000 : 1;
      return json({ events: Array.from({ length: count }, (_, offset) => ({ version: 1, runId: 'same-run', seq: start + offset, attemptId: null, type: 'assistant', payload: { text: String(start + offset) }, createdAt: start + offset + 1 })) });
    }));
    const events = await getAgentRunEvents({ backendConnectionId: 'remote-a', id: 'same-run' });
    expect(events).toHaveLength(1001);
    expect(calls.map((url) => new URL(url).searchParams.get('afterSeq'))).toEqual(['-1', '999']);
  });
});
