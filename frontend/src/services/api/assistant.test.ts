import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantApiError,
  fetchAssistant,
  isAssistantInfo,
  isAssistantMissing,
  resetAssistant,
  updateAssistantSettings,
} from './assistant';

const GOOD = {
  nodeId: 'n1', workspaceId: 'w1', treeId: 't1',
  settings: { runtimeId: 'kiro', modelId: null, reasoning: null },
  supportedRuntimes: ['kiro', 'claude'],
};

const fetchMock = vi.fn();
const answer = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('isAssistantInfo', () => {
  it('accepts the documented shape and rejects anything else', () => {
    expect(isAssistantInfo(GOOD)).toBe(true);
    expect(isAssistantInfo({ ...GOOD, nodeId: 5 })).toBe(false);
    expect(isAssistantInfo({ ...GOOD, workspaceId: '' })).toBe(false);
    expect(isAssistantInfo({ ...GOOD, settings: null })).toBe(false);
    expect(isAssistantInfo({ ...GOOD, settings: { modelId: null } })).toBe(false);
    expect(isAssistantInfo({ ...GOOD, supportedRuntimes: 'kiro' })).toBe(false);
    expect(isAssistantInfo({ ...GOOD, supportedRuntimes: [1] })).toBe(false);
    expect(isAssistantInfo('<!doctype html>')).toBe(false);
  });
});

describe('assistant API', () => {
  it('reads, saves and resets the assistant', async () => {
    answer(200, GOOD).mockResolvedValueOnce(new Response(JSON.stringify(GOOD))).mockResolvedValueOnce(new Response(JSON.stringify(GOOD)));
    await expect(fetchAssistant()).resolves.toEqual(GOOD);
    await expect(updateAssistantSettings({ modelId: 'opus' })).resolves.toEqual(GOOD);
    await expect(resetAssistant()).resolves.toEqual(GOOD);
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url).replace(/^.*\/api/, ''), init?.method ?? 'GET', init?.body])).toEqual([
      ['/assistant', 'GET', undefined],
      ['/assistant/settings', 'PUT', JSON.stringify({ modelId: 'opus' })],
      ['/assistant/reset', 'POST', '{}'],
    ]);
  });

  it('binds a new conversation request to the conversation currently shown', async () => {
    answer(200, GOOD);
    await resetAssistant('old-node');
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ nodeId: 'old-node' }));
  });

  it('reads a 404 as no assistant', async () => {
    answer(404, { error: 'Not found' });
    const err = await fetchAssistant().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AssistantApiError);
    expect(isAssistantMissing(err)).toBe(true);
  });

  it('reads an answer of the wrong shape as no assistant', async () => {
    answer(200, { ok: true });
    const err = await fetchAssistant().catch((e: unknown) => e);
    expect(isAssistantMissing(err)).toBe(true);
  });

  it('keeps other failures apart from a missing assistant', async () => {
    answer(500, { error: 'boom' });
    const err = await fetchAssistant().catch((e: unknown) => e) as AssistantApiError;
    expect(err.status).toBe(500);
    expect(err.message).toBe('boom');
    expect(isAssistantMissing(err)).toBe(false);
    expect(isAssistantMissing(new Error('offline'))).toBe(false);
  });
});
