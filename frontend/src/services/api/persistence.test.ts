import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAllWorkspacesMeta, fetchPersistenceCapabilities, supportsPaneInspection } from './persistence';
import { RemoteServiceRecoveryError } from './remoteRecovery';

/**
 * P2-5 capability discovery. The defensive predicate must return true ONLY
 * for the exact string 'v1' — absent, unknown, or malformed values all mean
 * unsupported, never "supported with an empty pane list" (design doc §11).
 */
describe('supportsPaneInspection', () => {
  it('is true for the exact "v1" capability value', () => {
    expect(supportsPaneInspection({ paneInspection: 'v1' })).toBe(true);
  });

  it('is false when the field is absent (old gateway)', () => {
    expect(supportsPaneInspection({})).toBe(false);
    expect(supportsPaneInspection({ paneInspection: undefined })).toBe(false);
  });

  it('is false for null/undefined capabilities object', () => {
    expect(supportsPaneInspection(null)).toBe(false);
    expect(supportsPaneInspection(undefined)).toBe(false);
  });

  it('is false for unknown/future version strings', () => {
    expect(supportsPaneInspection({ paneInspection: 'v2' })).toBe(false);
    expect(supportsPaneInspection({ paneInspection: 'V1' })).toBe(false);
  });

  it('is false for malformed non-string values, never coerced to true', () => {
    expect(supportsPaneInspection({ paneInspection: true })).toBe(false);
    expect(supportsPaneInspection({ paneInspection: 1 })).toBe(false);
    expect(supportsPaneInspection({ paneInspection: null })).toBe(false);
    expect(supportsPaneInspection({ paneInspection: {} })).toBe(false);
    expect(supportsPaneInspection({ paneInspection: ['v1'] })).toBe(false);
  });
});

describe('fetchPersistenceCapabilities — paneInspection field', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
      protocolVersion: 2,
      authoritativeTurnPersistence: true,
      durableNodePrerequisite: true,
      explicitCommands: true,
      backgroundWorkspaceSync: false,
      legacySyncAccepted: false,
      streamTransport: 'websocket-v1',
      paneInspection: 'v1',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the raw paneInspection value through untouched', async () => {
    const capabilities = await fetchPersistenceCapabilities('local');
    expect(supportsPaneInspection(capabilities)).toBe(true);
  });

  it('an old-gateway response with no paneInspection field is reported as unsupported', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      protocolVersion: 1,
      authoritativeTurnPersistence: false,
      durableNodePrerequisite: false,
      explicitCommands: false,
      backgroundWorkspaceSync: true,
      legacySyncAccepted: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const capabilities = await fetchPersistenceCapabilities('local');
    expect(supportsPaneInspection(capabilities)).toBe(false);
  });
});


it('preserves the remote gateway error and HTTP status while redacting credentials', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'SSH authentication failed. Authorization: Bearer hidden-value' }), { status: 502 })));
  try {
    await expect(fetchAllWorkspacesMeta('remote-c')).rejects.toThrow('HTTP 502');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'SSH authentication failed. Authorization: Bearer hidden-value' }), { status: 502 }));
    await expect(fetchAllWorkspacesMeta('remote-c')).rejects.toThrow('SSH authentication failed. Authorization: Bearer [redacted]');
  } finally { vi.unstubAllGlobals(); }
});

it('retains gateway recovery state for workspace retries and ignores a different machine’s status', async () => {
  const recovery = { connectionId: 'remote-c', phase: 'starting', message: 'Checking SSH…', diagnostic: { stage: 'ssh', log: 'Proxy waiting' } };
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ error: 'Starting remote Michi…', recovery }), { status: 502 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    const error = await fetchAllWorkspacesMeta('remote-c').catch(error => error);
    expect(error).toBeInstanceOf(RemoteServiceRecoveryError);
    expect(error.recovery).toEqual(recovery);
    expect(error.message).toContain('HTTP 502');
    const unrelated = await fetchAllWorkspacesMeta('other-machine').catch(error => error);
    expect(unrelated).not.toBeInstanceOf(RemoteServiceRecoveryError);
  } finally { vi.unstubAllGlobals(); }
});
