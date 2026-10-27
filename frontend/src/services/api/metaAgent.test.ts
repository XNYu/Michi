import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetaAgentInfo } from './metaAgent';
import {
  FOLLOW_GLOBAL_PATCH,
  MetaAgentApiError,
  fetchMetaAgent,
  isMetaAgentInfo,
  isMetaAgentUnavailable,
  retryMetaAgentGuard,
  updateMetaAgentSettings,
} from './metaAgent';

const GOOD: MetaAgentInfo = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null, writeWorkspaceHomes: null, maintainSpacesHome: null, firstRunDays: null },
  resolved: { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high', followsGlobal: true },
  availability: { available: true, reason: null },
  guard: { maintenance: null, chat: null },
  usageToday: null,
};
/** What a backend from before the reading, writing and usage fields answers. */
const OLDER = {
  settings: { runtimeId: null, providerId: null, modelId: null, reasoning: null },
  resolved: GOOD.resolved, availability: GOOD.availability, guard: GOOD.guard,
};

const fetchMock = vi.fn();
const answer = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('isMetaAgentInfo', () => {
  it('accepts the shared contract and rejects other shapes', () => {
    expect(isMetaAgentInfo(GOOD)).toBe(true);
    const failed = { state: 'failed', runtimeId: 'kiro', toolset: 'maintenance', unexpectedTools: ['fs_write'], checkedAt: 1 };
    expect(isMetaAgentInfo({ ...GOOD, guard: { maintenance: failed, chat: null } })).toBe(true);
    expect(isMetaAgentInfo({ ...GOOD, guard: { maintenance: { ...failed, unexpectedTools: 'fs_write' }, chat: null } })).toBe(false);
    expect(isMetaAgentInfo({ ...GOOD, resolved: { ...GOOD.resolved, runtimeId: '' } })).toBe(false);
    expect(isMetaAgentInfo({ ...GOOD, settings: { ...GOOD.settings, runtimeId: 3 } })).toBe(false);
    expect(isMetaAgentInfo({ settings: GOOD.settings })).toBe(false);
    expect(isMetaAgentInfo('<!doctype html>')).toBe(false);
  });
});

describe('Meta agent client', () => {
  it('reads GET /api/meta-agent', async () => {
    answer(200, GOOD);
    await expect(fetchMetaAgent()).resolves.toEqual(GOOD);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/meta-agent$/);
    expect(fetchMock.mock.calls[0][1]?.method).toBeUndefined();
  });

  it('keeps the availability the backend reports, and reads an answer without it as available', async () => {
    const crew = { ...GOOD, availability: { available: false, reason: 'The Meta agent does not run on Kiro Crew yet.' } };
    answer(200, crew);
    await expect(fetchMetaAgent()).resolves.toEqual(crew);
    const { availability: _omitted, ...older } = GOOD;
    answer(200, older);
    expect((await fetchMetaAgent()).availability).toEqual({ available: true, reason: null });
    answer(200, { ...GOOD, availability: { available: 'no' } });
    expect(isMetaAgentUnavailable(await fetchMetaAgent().catch((err: unknown) => err))).toBe(true);
  });

  it('sends the patch as PUT /api/meta-agent/settings, nulls included', async () => {
    answer(200, GOOD);
    await updateMetaAgentSettings(FOLLOW_GLOBAL_PATCH);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/meta-agent\/settings$/);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ runtimeId: null, providerId: null, modelId: null, reasoning: null });
  });

  it('reads the reading and writing settings and today’s usage, filling in what an older backend leaves out', async () => {
    const full = { ...GOOD, settings: { ...GOOD.settings, writeWorkspaceHomes: false, maintainSpacesHome: null, firstRunDays: 7 },
      usageToday: { checks: 3, modelCalls: 1, tokens: null } };
    answer(200, full);
    await expect(fetchMetaAgent()).resolves.toEqual(full);
    answer(200, OLDER);
    const older = await fetchMetaAgent();
    expect(older).toEqual(GOOD);
    for (const bad of [{ settings: { ...GOOD.settings, firstRunDays: 14 } }, { settings: { ...GOOD.settings, writeWorkspaceHomes: 'off' } },
      { usageToday: { checks: -1, modelCalls: 0, tokens: null } }, { usageToday: { checks: 1, modelCalls: 0 } }]) {
      answer(200, { ...GOOD, ...bad });
      expect(isMetaAgentUnavailable(await fetchMetaAgent().catch((err: unknown) => err)), JSON.stringify(bad)).toBe(true);
    }
  });

  it('retries a failed check with POST /api/meta-agent/retry and answers the new info', async () => {
    answer(200, GOOD);
    await expect(retryMetaAgentGuard('maintenance')).resolves.toMatchObject({ resolved: GOOD.resolved, guard: GOOD.guard });
    answer(200, GOOD);
    await retryMetaAgentGuard();
    const [[url, init], [, both]] = fetchMock.mock.calls;
    expect(String(url)).toMatch(/\/meta-agent\/retry$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ toolset: 'maintenance' });
    expect(JSON.parse(both.body)).toEqual({});
    answer(400, { error: 'toolset must be maintenance or chat' });
    await expect(retryMetaAgentGuard('chat')).rejects.toThrow('toolset must be maintenance or chat');
  });

  it('treats a 404 or a non-contract answer as unavailable, and other errors as failures', async () => {
    answer(404, { error: 'Not found' });
    const missing = await fetchMetaAgent().catch((err: unknown) => err);
    expect(isMetaAgentUnavailable(missing)).toBe(true);

    answer(200, '<!doctype html>');
    expect(isMetaAgentUnavailable(await fetchMetaAgent().catch((err: unknown) => err))).toBe(true);

    answer(400, { error: { code: 'invalid_runtime', message: 'Unknown runtime' } });
    const invalid = await updateMetaAgentSettings({ runtimeId: 'nope' }).catch((err: unknown) => err);
    expect(invalid).toBeInstanceOf(MetaAgentApiError);
    expect(isMetaAgentUnavailable(invalid)).toBe(false);
    expect((invalid as Error).message).toBe('Unknown runtime');
  });
});
