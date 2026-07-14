/**
 * /api/ready cold-start polling — verifies the chatStore boot effect
 * loads /agent/status immediately for composer chrome, tracks /api/ready
 * separately for warm failures, and keeps reload events on the status path.
 */
import React from 'react';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';

vi.mock('../services/api', () => ({
  __esModule: true,
  ensureSession: vi.fn().mockResolvedValue('test-session'),
  fetchAgentStatus: vi.fn(),
  fetchReady: vi.fn(),
  listAgentModes: vi.fn().mockResolvedValue([]),
  listAgentModels: vi.fn().mockResolvedValue({ models: [], sanitizedModel: null }),
  setChatMode: vi.fn(),
  respondToPermission: vi.fn(),
  cancelPermission: vi.fn(),
  warmCwd: vi.fn(),
  claimPane: vi.fn().mockResolvedValue({ owner: true }),
  heartbeatPane: vi.fn().mockResolvedValue(true),
  releasePane: vi.fn().mockResolvedValue(undefined),
  subscribeChat: vi.fn(() => () => {}),
  cancelChat: vi.fn().mockResolvedValue(undefined),
  // workspacePersistence dependencies — return empty so hydration finishes quickly.
  fetchAllWorkspaces: vi.fn().mockResolvedValue([]),
  fetchWorkspaces: vi.fn().mockResolvedValue([]),
  fetchWorkspace: vi.fn().mockResolvedValue(null),
  syncWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  deleteWorkspace: vi.fn().mockResolvedValue({ ok: true }),
  migrateLocalStorage: vi.fn().mockResolvedValue({ migrated: false }),
  fetchPrefs: vi.fn().mockResolvedValue(null),
  savePrefs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/notifications', () => ({ notify: vi.fn() }));

import * as api from '../services/api';
import { ChatProvider, useChatStore } from './chatStore';
import { PrefsProvider } from './prefs';

// Stub matchMedia — jsdom lacks it and some hooks probe for it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

function Probe() {
  const { agentStatus, warmFailedError } = useChatStore();
  return (
    <div>
      <span data-testid="status">{agentStatus ? 'ready' : 'null'}</span>
      <span data-testid="error">{warmFailedError ?? ''}</span>
    </div>
  );
}

function WarmProjectProbe() {
  const { createProject } = useChatStore();
  const created = React.useRef(false);
  React.useEffect(() => {
    if (created.current) return;
    created.current = true;
    void createProject('Warm target', '/tmp');
  }, [createProject]);
  return null;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>{children}</ChatProvider>
    </PrefsProvider>
  );
}

const STATUS_FIXTURE = {
  runtime: 'kiro',
  label: 'Kiro',
  capabilities: {
    modes: false,
    permissions: false,
    models: false,
    providerModels: false,
    reasoning: false,
    supportedReasoningLevels: [],
    apiKeys: false,
    warmSessions: false,
    saveContext: false,
    spawnBranches: false,
    nativeResume: false,
  },
  availableRuntimes: [],
  provider: '',
  providers: undefined,
  model: null,
  modelByRuntime: {},
  reasoning: 'medium' as const,
  reasoningByRuntime: {},
  hasRequiredKey: true,
};

describe('chatStore boot ready polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.fetchAgentStatus as any).mockResolvedValue(STATUS_FIXTURE);
    (api.listAgentModels as any).mockResolvedValue({ models: [], sanitizedModel: null });
  });

  test('loads agent status without waiting for ready or the model catalog', async () => {
    let resolveReady: (v: { status: 'ready' | 'pending'; error: null }) => void = () => {};
    (api.fetchReady as any).mockImplementation(
      () => new Promise((r) => { resolveReady = r as any; }),
    );
    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      capabilities: { ...STATUS_FIXTURE.capabilities, models: true },
    });
    (api.listAgentModels as any).mockImplementation(
      () => new Promise(() => {}),
    );

    const { getByTestId } = render(
      wrapper({ children: <Probe /> }),
    );

    await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('ready'));

    await act(async () => {
      resolveReady({ status: 'ready', error: null });
    });
  });

  test('retries /agent/status after a cold-start failure, before warm finishes', async () => {
    // The renderer mounts before the backend is listening (the dev norm: the
    // window loads from the vite server while the backend boots separately),
    // so the first fetch rejects. /api/ready stays `pending` the whole time —
    // warm never completes — yet the composer chips must still appear from the
    // status retry alone. Regression guard for chips that were blank until warm.
    (api.fetchReady as any).mockResolvedValue({ status: 'pending', error: null });
    (api.fetchAgentStatus as any)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({
        ...STATUS_FIXTURE,
        capabilities: { ...STATUS_FIXTURE.capabilities, modes: true },
      });

    const { getByTestId } = render(
      wrapper({ children: <Probe /> }),
    );

    await waitFor(() => expect(getByTestId('status').textContent).toBe('ready'));
    // Proven without warm: /api/ready only ever returned `pending`, so the
    // success came from the loadUntilLoaded retry, not the watchReady backstop.
    expect((api.fetchAgentStatus as any).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('failed ready surfaces error without blocking status', async () => {
    (api.fetchReady as any).mockResolvedValue({
      status: 'failed',
      error: 'kiro-cli ENOENT',
    });

    const { getByTestId } = render(
      wrapper({ children: <Probe /> }),
    );
    await waitFor(() =>
      expect(getByTestId('error').textContent).toBe('kiro-cli ENOENT'),
    );
    await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('ready'));
  });

  test('reload event bypasses ready poll', async () => {
    (api.fetchReady as any).mockResolvedValue({ status: 'ready', error: null });
    render(wrapper({ children: <Probe /> }));
    await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalledTimes(1));
    (api.fetchReady as any).mockClear();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    });

    await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalledTimes(2));
    expect(api.fetchReady).not.toHaveBeenCalled();
  });

  // Regression: on desktop cold start the first /api/modes fetch can be refused
  // before the backend is listening. The /agent picker must still populate once
  // the backend answers — not stay stuck on "Loading…" forever (Kiro-CLI agents
  // vanishing from the picker). The modes fetch is retried alongside status.
  test('recovers available modes after a cold-start fetch failure', async () => {
    const modes = [{ id: 'gpu-dev', name: 'gpu-dev' }];
    (api.listAgentModes as any)
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(modes);
    (api.fetchReady as any).mockResolvedValue({ status: 'pending', error: null });

    function ModesProbe() {
      const { availableModes } = useChatStore();
      return <span data-testid="modes">{availableModes.map((m) => m.id).join(',')}</span>;
    }

    const { getByTestId } = render(wrapper({ children: <ModesProbe /> }));

    // /api/ready never reports `ready`, so recovery comes from the retry loop,
    // not the watchReady backstop.
    await waitFor(() => expect(getByTestId('modes').textContent).toBe('gpu-dev'));
  });

  test('re-warms the same cwd when runtime or model changes', async () => {
    (api.fetchReady as any).mockResolvedValue({ status: 'ready', error: null });
    (api.warmCwd as any).mockResolvedValue(undefined);
    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      runtime: 'kiro',
      model: 'claude-opus-4.8',
    });

    render(wrapper({ children: <WarmProjectProbe /> }));
    await waitFor(() => expect(api.warmCwd).toHaveBeenCalledTimes(1));
    expect(api.warmCwd).toHaveBeenLastCalledWith('/tmp');

    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      runtime: 'gemini',
      model: 'gemini-2.5-pro',
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    });
    await waitFor(() => expect(api.warmCwd).toHaveBeenCalledTimes(2));

    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      runtime: 'gemini',
      model: 'gemini-2.5-flash',
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    });
    await waitFor(() => expect(api.warmCwd).toHaveBeenCalledTimes(3));

    (api.fetchAgentStatus as any).mockResolvedValue({
      ...STATUS_FIXTURE,
      runtime: 'kiro',
      model: 'claude-opus-4.8',
    });
    await act(async () => {
      window.dispatchEvent(new CustomEvent('michi:reload-agent-status'));
    });
    await waitFor(() => expect(api.warmCwd).toHaveBeenCalledTimes(4));
  });
});
