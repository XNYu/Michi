import type { Page, Route } from '@playwright/test';
import {
  AgentDefinitionStatus,
  AgentRunCompletionMode,
  AgentRunEventType,
  AgentRunInvocationMode,
  AgentRunStatus,
  encodeChatStreamEvent,
  type AgentDefinitionDtoV1,
  type AgentRunAttemptDtoV1,
  type AgentRunDtoV1,
  type AgentRunEventV1,
  type AgentRunInteractionDtoV1,
  type ChatStreamEvent,
  type CreateAgentDefinitionRequestV1,
} from 'michi-shared';

// ── SSE helpers ──────────────────────────────────────────────────────────────
//
// Backend SSE format (see backend/src/routes and frontend/src/services/api.ts:
// streamMessage). Frame layout per event:
//
//   event: <name>\n
//   data: <json>\n
//   \n
//
// Frontend splits on `\n\n`, then strips `event:` / `data:` lines. We just
// concatenate frames into one body and let Playwright fulfill in a single
// chunk — the parser doesn't care whether bytes arrive at once or in chunks.

export type SseEvent = ChatStreamEvent;

export function sseBody(events: SseEvent[]): string {
  return events.map(encodeChatStreamEvent).join('');
}

export const defaultTurn: SseEvent[] = [
  { event: 'chunk', data: { text: 'Hello from mock kiro. ' } },
  { event: 'chunk', data: { text: 'This is a fake reply.' } },
  { event: 'title', data: { title: 'Mock turn' } },
  { event: 'follow_ups', data: { followUps: ['Tell me more', 'What else?', 'Stop'] } },
  { event: 'done', data: { stopReason: 'end_turn' } },
];

// ── Endpoint registry ────────────────────────────────────────────────────────
//
// Anything not listed here gets a generic `{}` 200 response so the app
// doesn't trip on an unmocked endpoint. Override anything you care about
// per-spec via `installMockApi(page, { overrides: { ... } })`.

export interface MockOverrides {
  /** Custom SSE timeline for POST /api/chats/:id/message. */
  streamEvents?: SseEvent[];
  /** Delay (ms) before SSE body is sent. Used by cancel-resume specs. */
  streamDelayMs?: number;
  /** Pre-seeded workspaces returned by GET /api/workspaces and /workspaces/all. */
  workspaces?: unknown[];
  /** Custom route handler. Called BEFORE built-ins — return true to short-circuit. */
  custom?: (route: Route) => Promise<boolean>;
}

const AGENT_HASH = 'a'.repeat(64);

/** Stateful hermetic Custom Agents backend used by the release E2E. */
export function createCustomAgentsMockController() {
  let definition: AgentDefinitionDtoV1 | null = null;
  let waitingResolved = false;
  const ensureSessionBodies: Array<Record<string, unknown>> = [];
  const continuedRunIds: string[] = [];
  const savedRunIds: string[] = [];

  const effective = () => ({
    version: 1 as const,
    name: definition?.name ?? 'E2E Implementer',
    description: definition?.description ?? 'Hermetic worker',
    instructions: definition?.instructions ?? 'Complete the bounded task.',
    runtimeProfile: definition?.runtimeProfile ?? { version: 1 as const, runtimeId: 'pi', providerId: 'mock', modelId: 'flash' },
    fallbackChain: definition?.fallbackChain ?? [],
    capabilitySnapshot: { version: 1 as const, entries: [] },
    permissionPolicy: definition?.permissionPolicy ?? {
      version: 1 as const, preset: 'build' as const, categories: {}, maxDelegationDepth: 1,
      maxConcurrentRuns: 2, maxWallTimeMs: 60_000, maxAttempts: 2,
    },
    contextPolicy: definition?.contextPolicy ?? {
      version: 1 as const, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 10_000,
    },
  });

  const result = (conclusion: string): NonNullable<AgentRunDtoV1['resultBundle']> => ({
    version: 1, status: 'completed', source: 'submitted',
    handoff: { conclusion, artifactsOrChanges: 'Validated in the hermetic workspace.', unresolvedIssues: '' },
    artifacts: [], resourceMutations: [], externalActions: [],
  });

  const runs = (workspaceId: string): AgentRunDtoV1[] => {
    if (!definition || definition.status !== AgentDefinitionStatus.Enabled) return [];
    const common = {
      version: 1 as const, ownerUserId: 'local-user', workspaceId,
      effectiveDefinition: effective(), completionMode: AgentRunCompletionMode.Wake,
      parentRunId: null, parentAttemptId: null, parentNodeId: 'mock-parent-node',
      parentTurnId: 'turn-e2e', parentMessageId: 'assistant-e2e', parentToolCallId: 'tool-e2e',
      contextManifest: { version: 1 as const, entries: [], assembledAt: 1, estimatedChars: 0 },
      expectedResult: null,
      executionEnvironment: { version: 1 as const, kind: 'git_worktree' as const, cwd: '/mock/worktree',
        sourceWorkspaceId: workspaceId, baseCommit: 'abc123', snapshotHash: AGENT_HASH, createdAt: 1 },
      latestEventSeq: 2, createdAt: 1, startedAt: 2, archivedAt: null, expiresAt: null,
    };
    const saved: AgentRunDtoV1 = {
      ...common, id: 'run-saved', definitionId: definition.id, definitionRevision: definition.revision,
      invocationMode: AgentRunInvocationMode.Delegated, task: 'Saved Definition Run',
      status: AgentRunStatus.Completed, waitingReason: null, activeAttemptId: null,
      resultBundle: result('Saved Agent completed'), completedAt: 5,
    };
    const ephemeral: AgentRunDtoV1 = {
      ...common, id: 'run-ephemeral', definitionId: null, definitionRevision: null,
      invocationMode: AgentRunInvocationMode.Delegated, task: 'Ephemeral fallback Run',
      status: waitingResolved ? AgentRunStatus.Completed : AgentRunStatus.Waiting,
      waitingReason: waitingResolved ? null : 'permission', activeAttemptId: waitingResolved ? null : 'attempt-ephemeral-2',
      resultBundle: waitingResolved ? result('Ephemeral Agent completed after approval') : null,
      completedAt: waitingResolved ? 8 : null,
    };
    return [saved, ephemeral];
  };

  const attempts = (runId: string): AgentRunAttemptDtoV1[] => runId === 'run-ephemeral' ? [{
    version: 1, id: 'attempt-ephemeral-1', runId, attemptIndex: 0, profileIndex: 0,
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'mock', modelId: 'slow' },
    status: 'failed', publicSessionId: 'public-1', recoveryEnvelope: null, startedAt: 2,
    checkpointAt: 3, completedAt: 4,
    error: { version: 1, code: 'capacity', category: 'capacity', message: 'mock capacity fallback', retryable: true },
  }, {
    version: 1, id: 'attempt-ephemeral-2', runId, attemptIndex: 1, profileIndex: 1,
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'mock', modelId: 'flash' },
    status: waitingResolved ? 'completed' : 'waiting', publicSessionId: 'public-2', recoveryEnvelope: null,
    startedAt: 5, checkpointAt: 6, completedAt: waitingResolved ? 8 : null, error: null,
  }] : [{
    version: 1, id: 'attempt-saved-1', runId, attemptIndex: 0, profileIndex: 0,
    runtimeProfile: effective().runtimeProfile, status: 'completed', publicSessionId: 'public-saved',
    recoveryEnvelope: null, startedAt: 2, checkpointAt: 3, completedAt: 5, error: null,
  }];

  const events = (runId: string): AgentRunEventV1[] => [{
    version: 1, runId, seq: 0, attemptId: attempts(runId)[0]?.id ?? null,
    type: AgentRunEventType.Assistant, payload: { version: 1, text: `${runId} transcript` }, createdAt: 3,
  }, ...(runId === 'run-ephemeral' ? [{
    version: 1 as const, runId, seq: 1, attemptId: 'attempt-ephemeral-2',
    type: AgentRunEventType.RecoveryStarted,
    payload: { version: 1, reason: 'fallback' }, createdAt: 5,
  }] : [])];

  const interactions = (runId: string): AgentRunInteractionDtoV1[] => runId === 'run-ephemeral' ? [{
    version: 1, id: 'interaction-permission', runId, attemptId: 'attempt-ephemeral-2', kind: 'permission',
    status: waitingResolved ? 'resolved' : 'pending', request: { tool: 'bash', command: 'npm test' },
    response: waitingResolved ? { decision: 'allow' } : null, createdAt: 6, resolvedAt: waitingResolved ? 7 : null,
  }] : [];

  const json = (route: Route, data: unknown, status = 200) => route.fulfill({
    status, contentType: 'application/json', body: JSON.stringify(data),
  });

  return {
    ensureSessionBodies,
    continuedRunIds,
    savedRunIds,
    get definition() { return definition; },
    async handle(route: Route): Promise<boolean> {
      const request = route.request();
      const url = new URL(request.url());
      const apiPath = url.pathname.replace(/^.*\/api/, '');
      const method = request.method();
      if (method === 'GET' && apiPath === '/agent/status') {
        await json(route, {
          runtime: 'mock', label: 'Mock Runtime', hasRequiredKey: true,
          capabilities: { modes: true, permissions: true, models: false, providerModels: false,
            reasoning: false, apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: true },
          availableRuntimes: [{ id: 'mock', label: 'Mock Runtime', available: true }],
        });
        return true;
      }
      if (method === 'POST' && /^\/nodes\/[^/]+\/ensure-session$/.test(apiPath)) {
        ensureSessionBodies.push(request.postDataJSON() as Record<string, unknown>);
        return false;
      }
      if (apiPath === '/agents' && method === 'GET') {
        const enabledOnly = url.searchParams.get('discover') === 'enabled';
        await json(route, { definitions: definition && (!enabledOnly || definition.status === AgentDefinitionStatus.Enabled) ? [definition] : [] });
        return true;
      }
      if (apiPath === '/agent-capabilities' && method === 'GET') {
        // Browse-time catalog for the editor's capability chips.
        await json(route, { capabilities: [{
          version: 1, id: 'web_search', kind: 'tool', ownerUserId: 'local-user', workspaceId: null,
          revision: 'rev-1', readiness: 'ready', publicSchema: {}, publicConfig: {},
          schemaHash: 'a'.repeat(64), contentHash: null, configHash: 'a'.repeat(64), credentialBindingIds: [],
        }] });
        return true;
      }
      if (apiPath === '/agents' && method === 'POST') {
        const body = request.postDataJSON() as CreateAgentDefinitionRequestV1;
        definition = { ...body, id: 'agent-e2e', ownerUserId: 'local-user', status: AgentDefinitionStatus.Draft,
          revision: 1, createdAt: 1, updatedAt: 1 };
        await json(route, { definition }); return true;
      }
      if (method === 'POST' && apiPath === '/agents/agent-e2e/enable' && definition) {
        definition = { ...definition, status: AgentDefinitionStatus.Enabled, revision: 2, updatedAt: 2 };
        await json(route, { definition }); return true;
      }
      if (method === 'GET' && apiPath === '/agents/agent-e2e' && definition) {
        await json(route, { definition }); return true;
      }
      if (method === 'GET' && apiPath === '/agent-runs/subscribe') {
        await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: heartbeat\ndata: ${JSON.stringify({ version: 1, event: 'heartbeat', runId: null, seq: null, eventData: null, gapAfterSeq: null, emittedAt: 1 })}\n\n` });
        return true;
      }
      if (method === 'GET' && apiPath === '/agent-runs') {
        const workspaceId = url.searchParams.get('workspaceId') ?? 'workspace-e2e';
        await json(route, { runs: runs(workspaceId) }); return true;
      }
      const detail = apiPath.match(/^\/agent-runs\/(run-saved|run-ephemeral)$/);
      if (method === 'GET' && detail) {
        const workspaceId = definition?.workspaceId ?? 'workspace-e2e';
        const run = runs(workspaceId).find((candidate) => candidate.id === detail[1]);
        await json(route, run ? { run, attempts: attempts(run.id), events: events(run.id), interactions: interactions(run.id) } : { error: 'not_found' }, run ? 200 : 404);
        return true;
      }
      const eventList = apiPath.match(/^\/agent-runs\/(run-saved|run-ephemeral)\/events$/);
      if (method === 'GET' && eventList) { await json(route, { events: events(eventList[1]) }); return true; }
      if (method === 'POST' && apiPath === '/agent-runs/run-ephemeral/interactions/interaction-permission/respond') {
        waitingResolved = true;
        await json(route, { interaction: interactions('run-ephemeral')[0] }); return true;
      }
      const continuation = apiPath.match(/^\/agent-runs\/(run-saved|run-ephemeral)\/continue-as-branch$/);
      if (method === 'POST' && continuation) {
        continuedRunIds.push(continuation[1]);
        await json(route, { version: 1, runId: continuation[1], workspaceId: definition?.workspaceId,
          nodeId: 'continued-node', treeId: 'continued-tree', parentNodeId: 'mock-parent-node', mode: 'branch',
          imported: { task: true, result: true, transcript: false } }, 201);
        return true;
      }
      const save = apiPath.match(/^\/agent-runs\/(run-ephemeral)\/save-as-agent$/);
      if (method === 'POST' && save) {
        savedRunIds.push(save[1]);
        const saved: AgentDefinitionDtoV1 = { ...definition!, id: 'agent-from-run', name: 'Saved Ephemeral Agent',
          status: AgentDefinitionStatus.Draft, revision: 1, createdAt: 9, updatedAt: 9 };
        await json(route, { version: 1, runId: save[1], definition: saved }, 201); return true;
      }
      return false;
    },
  };
}

let chatIdCounter = 0;
let nodeIdCounter = 0;
function nextChatId() {
  chatIdCounter += 1;
  return `mock-chat-${chatIdCounter}`;
}

function nextNodeId() {
  nodeIdCounter += 1;
  return `n-mock-${nodeIdCounter}`;
}

export async function installMockApi(page: Page, overrides: MockOverrides = {}) {
  chatIdCounter = 0;
  nodeIdCounter = 0;

  // Match only real backend calls: `<origin>/api/...`. A plain `**/api/**`
  // glob also matches Vite dev module URLs like
  // `http://127.0.0.1:3001/src/services/api/artifacts.ts` (the `/api/` segment
  // sits mid-path), which would return JSON for a module script and white-screen
  // the app. Anchoring `/api/` to just after the host avoids that.
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    if (overrides.custom && (await overrides.custom(route))) return;

    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');
    const method = route.request().method();

    // ── SSE stream ───────────────────────────────────────────────────────
    if (method === 'POST' && /^\/chats\/[^/]+\/message$/.test(path)) {
      if (overrides.streamDelayMs) {
        await new Promise((r) => setTimeout(r, overrides.streamDelayMs));
      }
      const body = sseBody(overrides.streamEvents ?? defaultTurn);
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache' },
        body,
      });
    }
    if (method === 'POST' && path === '/chats/background/subscribe') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache' },
        body: ': keepalive\n\n',
      });
    }
    if (method === 'GET' && /^\/chats\/[^/]+\/stream$/.test(path)) {
      const turnId = url.searchParams.get('fromTurnId') ?? 'mock-replay-turn';
      const seq = Number(url.searchParams.get('fromSeq') ?? 0);
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache' },
        body: sseBody([{
          event: 'done',
          data: { turnId, seq, assistantId: 'mock-replay-assistant', persisted: true },
        }]),
      });
    }

    // ── JSON endpoints ───────────────────────────────────────────────────
    const json = (data: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });

    // chat create
    if (method === 'POST' && path === '/chats') {
      return json({ chatId: nextChatId(), currentModeId: null });
    }
    if (method === 'POST' && path === '/node-ids/allocate') {
      let count = 1;
      try {
        const body = route.request().postDataJSON() as { count?: unknown };
        if (typeof body.count === 'number') count = body.count;
      } catch {
        count = 1;
      }
      return json({ nodeIds: Array.from({ length: count }, () => nextNodeId()) });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/load$/.test(path)) {
      return json({ currentModeId: null });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/cancel$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/claim$/.test(path)) {
      return json({ owner: true });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/heartbeat$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/release$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/set-(mode|model)$/.test(path)) {
      return json({ currentModeId: null, currentModelId: 'mock-model' });
    }

    // boot gates (added to the app after these fixtures were first written).
    // Without these the app parks on the FirstRunSetup "Welcome to Michi"
    // wizard: the workspace-dialog auto-open in TerminalShell is gated on
    // `prefs.onboardingCompletedAt != null`, and FirstRunSetup itself pops
    // whenever onboarding is incomplete. Returning a completed-onboarding pref
    // simulates a returning user, suppressing the wizard and letting the
    // new-workspace dialog auto-open — the state every spec's bootWithWorkspace
    // expects.
    if (method === 'GET' && path === '/prefs') {
      return json({ prefs: { onboardingCompletedAt: 1 } });
    }
    if (method === 'PUT' && path === '/prefs') {
      return json({ ok: true });
    }
    if (method === 'GET' && path === '/ready') {
      return json({ status: 'ready', error: null });
    }
    if (method === 'GET' && path === '/auth-config') {
      return json({ requireAuth: false });
    }
    if (method === 'GET' && path === '/persistence/capabilities') {
      // Advisory probe (workspacePersistence never gates on it), but returning
      // the real v2 shape keeps the boot console clean.
      return json({
        protocolVersion: 2,
        authoritativeTurnPersistence: true,
        durableNodePrerequisite: true,
        explicitCommands: true,
        backgroundWorkspaceSync: false,
        legacySyncAccepted: true,
      });
    }

    // workspaces
    if (method === 'GET' && (path === '/workspaces' || path === '/workspaces/all')) {
      return json({ workspaces: overrides.workspaces ?? [] });
    }
    if (method === 'POST' && /^\/workspaces\/[^/]+\/sync$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'DELETE' && /^\/workspaces\/[^/]+$/.test(path)) {
      return json({ ok: true });
    }

    // nodes
    if (method === 'POST' && /^\/nodes\/[^/]+\/ensure-session$/.test(path)) {
      let requestBody: { chatId?: unknown } = {};
      try {
        requestBody = route.request().postDataJSON() as { chatId?: unknown };
      } catch {
        requestBody = {};
      }
      const existingChatId = typeof requestBody.chatId === 'string' ? requestBody.chatId : null;
      const nodeId = path.split('/')[2];
      return json({
        chatId: nodeId,
        currentModeId: null,
        resumeStrategy: existingChatId ? 'live' : 'fresh',
      });
    }
    if (method === 'PATCH' && /^\/nodes\/[^/]+$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'POST' && /^\/nodes\/[^/]+\/messages$/.test(path)) {
      return json({ ok: true });
    }

    // bootstrap
    if (path === '/agent/status') {
      return json({
        runtime: 'mock',
        label: 'Mock Runtime',
        capabilities: {
          modes: false,
          permissions: false,
          providerModels: false,
          reasoning: false,
          apiKeys: false,
          warmSessions: false,
          saveContext: false,
          spawnBranches: false,
        },
        availableRuntimes: [{ id: 'mock', label: 'Mock Runtime', available: true }],
        hasRequiredKey: true,
      });
    }
    if (path === '/modes') return json({ availableModes: [] });
    if (path === '/models') return json({ models: [], default_model: null });
    if (path === '/agent/models') return json({ models: [] });
    if (path === '/version') {
      return json({
        localHash: 'mock',
        localDate: '2026-01-01',
        remoteHash: null,
        remoteName: null,
        updateAvailable: false,
      });
    }
    if (method === 'POST' && path === '/warm') return json({ ok: true });
    if (method === 'POST' && path === '/migrate') return json({ migrated: false });

    // Default: empty 200. Loud enough to find in traces if we missed something.
    return json({ __unmocked: path });
  });
}

// ── App boot helpers ─────────────────────────────────────────────────────────

/**
 * Boot the app, dismiss the auto-opened "create workspace" dialog by creating
 * a default workspace with no cwd. Returns when the chat composer is visible.
 */
export async function bootWithWorkspace(page: Page, name = 'E2E Workspace') {
  await page.goto('/');

  // The new-workspace dialog auto-opens when there are no projects.
  // NewWorkspaceDialog has: <input placeholder="Untitled workspace"> + <button>Create</button>.
  const nameInput = page.getByPlaceholder(/workspace|untitled/i).first();
  await nameInput.waitFor({ state: 'visible', timeout: 10_000 });
  await nameInput.fill(name);
  await page.getByRole('button', { name: /^create$/i }).click();

  // Wait for the TipTap-backed MentionEditor used by the Home composer.
  await page.locator('[contenteditable="true"]').first().waitFor({ state: 'visible', timeout: 10_000 });
}
