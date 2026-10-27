import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRuntimeFieldCatalog } from './useRuntimeFieldCatalog';
import { catalogKey } from './AgentRuntimeProfileFields';
const api = vi.hoisted(() => ({ fetchAgentStatus: vi.fn(), fetchRuntimeCatalog: vi.fn() }));
vi.mock('../../../services/api/agentRuntime', () => api);
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
const response = (id: string) => ({ providers: [], models: [{ id }], capabilities: { reasoning: false, supportedReasoningLevels: [] } });
it('follows an explicit resource Backend across changes and ignores delayed status/catalog responses', async () => {
  let finishOld!: (value: unknown) => void;
  api.fetchAgentStatus.mockResolvedValue({ availableRuntimes: [{ id: 'claude', label: 'Claude', available: true }] });
  api.fetchRuntimeCatalog.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce(response('b-model'));
  const view = renderHook(({ connectionId }) => useRuntimeFieldCatalog(connectionId), { initialProps: { connectionId: 'catalog-a' } });
  await waitFor(() => expect(view.result.current).not.toBeNull());
  act(() => view.result.current?.request('claude', ''));
  view.rerender({ connectionId: 'catalog-b' });
  await waitFor(() => expect(api.fetchAgentStatus).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.result.current).not.toBeNull());
  act(() => view.result.current?.request('claude', ''));
  await waitFor(() => expect(view.result.current?.modelsFor[catalogKey('claude', '')]?.[0].id).toBe('b-model'));
  await act(async () => { finishOld(response('a-model')); });
  expect(view.result.current?.modelsFor[catalogKey('claude', '')]?.[0].id).toBe('b-model');
  expect(api.fetchRuntimeCatalog.mock.calls[0][2]).toEqual({ connectionId: 'catalog-a' });
  expect(api.fetchRuntimeCatalog.mock.calls[1][2]).toEqual({ connectionId: 'catalog-b' });
});
it('retries an initially unavailable catalog rather than permanently locking its key', async () => {
  vi.useFakeTimers();
  api.fetchAgentStatus.mockResolvedValue({ availableRuntimes: [] });
  api.fetchRuntimeCatalog.mockResolvedValueOnce({ ...response('pending'), capabilities: null }).mockResolvedValueOnce(response('ready'));
  const view = renderHook(() => useRuntimeFieldCatalog('local'));
  await act(async () => { await Promise.resolve(); });
  act(() => view.result.current?.request('claude', ''));
  await act(async () => { await Promise.resolve(); });
  expect(view.result.current?.modelsFor[catalogKey('claude', '')]).toBeUndefined();
  await act(async () => { vi.advanceTimersByTime(500); await Promise.resolve(); });
  expect(view.result.current?.modelsFor[catalogKey('claude', '')]?.[0].id).toBe('ready');
  act(() => view.result.current?.request('claude', ''));
  expect(api.fetchRuntimeCatalog).toHaveBeenCalledTimes(2);
});

it('leaves a failed catalog retryable after bounded automatic retries are exhausted', async () => {
  vi.useFakeTimers();
  api.fetchAgentStatus.mockResolvedValue({ availableRuntimes: [] });
  api.fetchRuntimeCatalog.mockRejectedValue(new Error('unavailable'));
  const view = renderHook(() => useRuntimeFieldCatalog('local'));
  await act(async () => { await Promise.resolve(); });
  act(() => view.result.current?.request('claude', ''));
  for (const delay of [500, 1_000, 2_000]) {
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(delay); await Promise.resolve(); });
  }
  expect(api.fetchRuntimeCatalog).toHaveBeenCalledTimes(4);
  expect(view.result.current?.errorsFor?.[catalogKey('claude', '')]).toBe('unavailable');
  api.fetchRuntimeCatalog.mockResolvedValue(response('recovered'));
  await act(async () => { view.result.current?.retry?.('claude', ''); await Promise.resolve(); });
  expect(view.result.current?.modelsFor[catalogKey('claude', '')]?.[0].id).toBe('recovered');
  expect(view.result.current?.errorsFor?.[catalogKey('claude', '')]).toBeUndefined();
});
