import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { MetaAgentInfo } from '../../services/api/metaAgent';
import { MetaAgentApiError } from '../../services/api/metaAgent';
import {
  readMetaAgent,
  refreshMetaAgent,
  resetMetaAgentStore,
  saveMetaAgentSettings,
  useMetaAgentGuardFailed,
} from './useMetaAgent';

vi.mock('sonner', () => ({ toast: vi.fn() }));
const api = vi.hoisted(() => ({ fetchMetaAgent: vi.fn(), updateMetaAgentSettings: vi.fn() }));
vi.mock('../../services/api/metaAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/metaAgent')>()),
  ...api,
}));

const OK: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: { runtimeId: 'kiro', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
};
const FAILED: MetaAgentInfo = {
  ...OK,
  guard: {
    maintenance: null,
    chat: { state: 'failed', runtimeId: 'kiro', toolset: 'chat', unexpectedTools: ['fs_write'], checkedAt: 1 },
  },
};

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

beforeEach(() => {
  api.fetchMetaAgent.mockReset();
  api.updateMetaAgentSettings.mockReset();
  resetMetaAgentStore();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useMetaAgentGuardFailed (Settings red dot)', () => {
  it('is on only while a restriction check failed', async () => {
    api.fetchMetaAgent.mockResolvedValue(FAILED);
    const { result } = renderHook(() => useMetaAgentGuardFailed());
    expect(result.current).toBe(false);
    await flush();
    expect(result.current).toBe(true);

    api.fetchMetaAgent.mockResolvedValue(OK);
    await act(() => refreshMetaAgent());
    expect(result.current).toBe(false);
  });

  it('shares one read and one poll between callers, and polls every minute while visible', async () => {
    vi.useFakeTimers();
    api.fetchMetaAgent.mockResolvedValue(OK);
    const first = renderHook(() => useMetaAgentGuardFailed());
    renderHook(() => useMetaAgentGuardFailed());
    await flush();
    expect(api.fetchMetaAgent).toHaveBeenCalledTimes(1);

    api.fetchMetaAgent.mockResolvedValue(FAILED);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(api.fetchMetaAgent).toHaveBeenCalledTimes(2);
    expect(first.result.current).toBe(true);
  });

  it('stays off and stops polling when the backend has no Meta agent', async () => {
    vi.useFakeTimers();
    api.fetchMetaAgent.mockRejectedValue(new MetaAgentApiError(404, 'Not found'));
    const { result } = renderHook(() => useMetaAgentGuardFailed());
    await flush();
    expect(readMetaAgent().status).toBe('unavailable');
    await act(async () => { vi.advanceTimersByTime(180_000); });
    expect(api.fetchMetaAgent).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
  });
});

describe('Meta agent store', () => {
  it('keeps a saved answer over a read that started before the save', async () => {
    let answerRead: (info: MetaAgentInfo) => void = () => {};
    api.fetchMetaAgent.mockReturnValue(new Promise<MetaAgentInfo>((resolve) => { answerRead = resolve; }));
    const pending = refreshMetaAgent();
    const saved = { ...OK, settings: { ...OK.settings, runtimeId: 'pi' } };
    api.updateMetaAgentSettings.mockResolvedValue(saved);
    await saveMetaAgentSettings({ runtimeId: 'pi' });
    answerRead(OK);
    await pending;
    expect(readMetaAgent().info).toBe(saved);
  });

  it('keeps the last answer when a later read fails', async () => {
    api.fetchMetaAgent.mockResolvedValue(FAILED);
    await refreshMetaAgent();
    api.fetchMetaAgent.mockRejectedValue(new Error('offline'));
    await refreshMetaAgent();
    expect(readMetaAgent()).toMatchObject({ status: 'ready', info: FAILED, error: 'offline' });
  });
});

it('notifies once per pending tool request while repeated polls keep the request visible', async () => {
  vi.mocked(toast).mockClear();
  const info: MetaAgentInfo = { ...OK, toolApprovals: [{ id: 'request', server: 'mail', tool: 'send', description: '', state: 'pending', requestedAt: 1, updatedAt: 1 }] };
  api.fetchMetaAgent.mockResolvedValue(info);
  await refreshMetaAgent(); await refreshMetaAgent();
  expect(toast).toHaveBeenCalledTimes(1);
  expect(readMetaAgent().info?.toolApprovals?.[0].state).toBe('pending');
});
