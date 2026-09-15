import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_BASE_URL } from '../../config/env';

vi.mock('./streamTransport', () => ({
  fetchStream: vi.fn(),
}));

import { fetchStream } from './streamTransport';
import { allocateSurfaceRegistration, panePresenceTransport } from './panePresence';

const LOCAL = 'local';
const WORKSPACE = 'ws-1';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('panePresenceTransport.submit (PUT /api/panes/presence)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, {
      ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [],
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs to /api/panes/presence with workspaceId folded into the body', async () => {
    const result = await panePresenceTransport.submit(LOCAL, WORKSPACE, {
      viewRevision: 1,
      windowId: 'window-1',
      views: [],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/panes/presence`);
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(body.workspaceId).toBe(WORKSPACE);
    expect(body.viewRevision).toBe(1);
    expect(body.windowId).toBe('window-1');
    expect(result).toEqual({ ok: true, rendererLeaseId: 'lease-1', accepted: 1, rejectedTargets: [] });
  });

  it('does not include workspaceId in the caller-supplied request shape twice', async () => {
    await panePresenceTransport.submit(LOCAL, WORKSPACE, {
      rendererLeaseId: 'lease-1',
      viewRevision: 2,
      windowId: 'window-1',
      views: [{ paneId: 'node:n1', windowId: 'window-1', uiPaneId: 'n1', treeId: null, visible: true, openedAtClient: 100 }],
    });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.rendererLeaseId).toBe('lease-1');
    expect(body.views).toHaveLength(1);
    expect(body.workspaceId).toBe(WORKSPACE);
  });

  it('returns the typed 409 STALE_REVISION result rather than throwing', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(409, { ok: false, code: 'STALE_REVISION', currentRevision: 5 }));
    const result = await panePresenceTransport.submit(LOCAL, WORKSPACE, { viewRevision: 1, windowId: 'w', views: [] });
    expect(result).toEqual({ ok: false, code: 'STALE_REVISION', currentRevision: 5 });
  });

  it('returns the typed 403 WRONG_WINDOW result rather than throwing', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(403, { ok: false, code: 'WRONG_WINDOW' }));
    const result = await panePresenceTransport.submit(LOCAL, WORKSPACE, { viewRevision: 1, windowId: 'w', views: [] });
    expect(result).toEqual({ ok: false, code: 'WRONG_WINDOW' });
  });

  it('returns the typed 200 EMPTY_SNAPSHOT_IGNORED result', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: false, code: 'EMPTY_SNAPSHOT_IGNORED', rendererLeaseId: 'lease-1' }));
    const result = await panePresenceTransport.submit(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1', viewRevision: 1, windowId: 'w', views: [] });
    expect(result).toEqual({ ok: false, code: 'EMPTY_SNAPSHOT_IGNORED', rendererLeaseId: 'lease-1' });
  });

  it('throws on an unexpected non-2xx/409/403 status', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(500, { code: 'INTERNAL', message: 'internal error' }));
    await expect(panePresenceTransport.submit(LOCAL, WORKSPACE, { viewRevision: 1, windowId: 'w', views: [] }))
      .rejects.toThrow(/submitPresence failed: 500/);
  });

  it('rejects a 200 body that does not match any SubmitPresenceResult variant', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { unexpected: 'shape' }));
    await expect(panePresenceTransport.submit(LOCAL, WORKSPACE, { viewRevision: 1, windowId: 'w', views: [] }))
      .rejects.toThrow(/submitPresence: malformed response body/);
  });

  it('rejects a 200 body missing required fields on the ok:true variant', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, rendererLeaseId: 'lease-1' }));
    await expect(panePresenceTransport.submit(LOCAL, WORKSPACE, { viewRevision: 1, windowId: 'w', views: [] }))
      .rejects.toThrow(/submitPresence: malformed response body/);
  });

  it('rejects a 409 body with a wrong-typed currentRevision', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(409, { ok: false, code: 'STALE_REVISION', currentRevision: 'not-a-number' }));
    await expect(panePresenceTransport.submit(LOCAL, WORKSPACE, { viewRevision: 1, windowId: 'w', views: [] }))
      .rejects.toThrow(/submitPresence: malformed response body/);
  });

  it('rejects an unparseable (non-JSON) body', async () => {
    fetchMock.mockImplementation(async () => new Response('not json', { status: 200 }));
    await expect(panePresenceTransport.submit(LOCAL, WORKSPACE, { viewRevision: 1, windowId: 'w', views: [] }))
      .rejects.toThrow(/submitPresence: malformed response body/);
  });

  it('resolves the base URL via backendApiBase for a non-local connection', async () => {
    await panePresenceTransport.submit('remote-1', WORKSPACE, { viewRevision: 1, windowId: 'w', views: [] });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/backend-connections/remote-1/proxy/panes/presence`);
  });
});

describe('panePresenceTransport.remove (DELETE /api/panes/presence)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, removed: 1 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('DELETEs with workspaceId folded into the body', async () => {
    const result = await panePresenceTransport.remove(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1', paneIds: ['node:n1'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/panes/presence`);
    expect(init.method).toBe('DELETE');
    const body = JSON.parse(init.body as string);
    expect(body.workspaceId).toBe(WORKSPACE);
    expect(body.rendererLeaseId).toBe('lease-1');
    expect(body.paneIds).toEqual(['node:n1']);
    expect(result).toEqual({ ok: true, removed: 1 });
  });

  it('returns the typed 404 NOT_FOUND result rather than throwing', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(404, { ok: false, code: 'NOT_FOUND' }));
    const result = await panePresenceTransport.remove(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1' });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('returns the typed 403 WRONG_WINDOW result rather than throwing', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(403, { ok: false, code: 'WRONG_WINDOW' }));
    const result = await panePresenceTransport.remove(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1' });
    expect(result).toEqual({ ok: false, code: 'WRONG_WINDOW' });
  });

  it('throws on an unexpected status', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(500, {}));
    await expect(panePresenceTransport.remove(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1' }))
      .rejects.toThrow(/removePresence failed: 500/);
  });

  it('rejects a 200 body that does not match any RemovePresenceResult variant', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { removed: 'not-a-number' }));
    await expect(panePresenceTransport.remove(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1' }))
      .rejects.toThrow(/removePresence: malformed response body/);
  });
});

describe('panePresenceTransport.keepalive (POST /api/panes/presence/keepalive, via fetchStream)', () => {
  let streamMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    streamMock = vi.mocked(fetchStream);
    streamMock.mockReset();
    streamMock.mockImplementation(async () => jsonResponse(200, { ok: true, renewedViews: 3 }));
  });

  it('calls fetchStream, not bare fetch, with workspaceId folded into the body', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await panePresenceTransport.keepalive(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamMock).toHaveBeenCalledTimes(1);
    const [url, init] = streamMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/panes/presence/keepalive`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.workspaceId).toBe(WORKSPACE);
    expect(body.rendererLeaseId).toBe('lease-1');
    expect(result).toEqual({ ok: true, renewedViews: 3 });

    vi.unstubAllGlobals();
  });

  it('returns the typed 404 NOT_FOUND result rather than throwing', async () => {
    streamMock.mockImplementation(async () => jsonResponse(404, { ok: false, code: 'NOT_FOUND' }));
    const result = await panePresenceTransport.keepalive(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1' });
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('throws on an unexpected non-2xx/404 status', async () => {
    streamMock.mockImplementation(async () => jsonResponse(500, {}));
    await expect(panePresenceTransport.keepalive(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1' }))
      .rejects.toThrow(/presenceKeepalive failed: 500/);
  });

  it('rejects a 200 body that does not match either PresenceKeepaliveResult variant', async () => {
    streamMock.mockImplementation(async () => jsonResponse(200, { renewedViews: 'nope' }));
    await expect(panePresenceTransport.keepalive(LOCAL, WORKSPACE, { rendererLeaseId: 'lease-1' }))
      .rejects.toThrow(/presenceKeepalive: malformed response body/);
  });

  it('resolves the base URL via backendApiBase for a non-local connection', async () => {
    await panePresenceTransport.keepalive('remote-1', WORKSPACE, { rendererLeaseId: 'lease-1' });
    const [url] = streamMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/backend-connections/remote-1/proxy/panes/presence/keepalive`);
  });
});

describe('allocateSurfaceRegistration (POST /api/panes/presence/allocate)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => jsonResponse(200, { registrationId: 'reg-1', paneId: 'surface:reg-1' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the surface kind and workspaceId, returning the allocated ids', async () => {
    const result = await allocateSurfaceRegistration(LOCAL, WORKSPACE, 'terminal');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/panes/presence/allocate`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.workspaceId).toBe(WORKSPACE);
    expect(body.kind).toBe('terminal');
    expect(result).toEqual({ registrationId: 'reg-1', paneId: 'surface:reg-1' });
  });

  it('throws on a non-2xx status', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(400, { code: 'INVALID_ARGUMENT', message: 'bad kind' }));
    await expect(allocateSurfaceRegistration(LOCAL, WORKSPACE, 'terminal')).rejects.toThrow(/allocateSurfaceRegistration failed: 400/);
  });

  it('rejects a 200 body missing registrationId or paneId', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { registrationId: 'reg-1' }));
    await expect(allocateSurfaceRegistration(LOCAL, WORKSPACE, 'terminal'))
      .rejects.toThrow(/allocateSurfaceRegistration: malformed response body/);
  });

  it('is not part of the PanePresenceTransport interface (production mounting owns allocation)', () => {
    expect((panePresenceTransport as unknown as Record<string, unknown>).allocateSurfaceRegistration).toBeUndefined();
  });
});


describe('panePresence response contract hardening', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fetchStream).mockReset();
  });

  it('rejects a success-shaped submit body carried by HTTP 409', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, {
      ok: true, rendererLeaseId: 'lease-wrong-status', accepted: 0, rejectedTargets: [],
    })));
    await expect(panePresenceTransport.submit(LOCAL, WORKSPACE, {
      viewRevision: 1, windowId: 'w', views: [],
    })).rejects.toThrow('submitPresence: malformed response body');
  });

  it('does not echo malformed response fields in parser errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      ok: true, secretUnexpectedField: 'must-not-appear-in-error',
    })));
    let error: Error | undefined;
    try {
      await panePresenceTransport.submit(LOCAL, WORKSPACE, {
        viewRevision: 1, windowId: 'w', views: [],
      });
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toBe('submitPresence: malformed response body');
    expect(error?.message).not.toContain('must-not-appear-in-error');
  });

  it('rejects a success-shaped remove body carried by HTTP 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { ok: true, removed: 0 })));
    await expect(panePresenceTransport.remove(LOCAL, WORKSPACE, {
      rendererLeaseId: 'lease-1',
    })).rejects.toThrow('removePresence: malformed response body');
  });

  it('rejects a success-shaped keepalive body carried by HTTP 404', async () => {
    vi.mocked(fetchStream).mockResolvedValueOnce(jsonResponse(404, { ok: true, renewedViews: 0 }));
    await expect(panePresenceTransport.keepalive(LOCAL, WORKSPACE, {
      rendererLeaseId: 'lease-1',
    })).rejects.toThrow('presenceKeepalive: malformed response body');
  });

  it('rejects allocation when paneId is not the canonical encoding of registrationId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      registrationId: 'reg-1', paneId: 'surface:different-registration',
    })));
    await expect(allocateSurfaceRegistration(LOCAL, WORKSPACE, 'terminal'))
      .rejects.toThrow('allocateSurfaceRegistration: malformed response body');
  });

  it('rejects negative or fractional count fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      ok: true, rendererLeaseId: 'lease-1', accepted: -1.5, rejectedTargets: [],
    })));
    await expect(panePresenceTransport.submit(LOCAL, WORKSPACE, {
      viewRevision: 1, windowId: 'w', views: [],
    })).rejects.toThrow('submitPresence: malformed response body');
  });
});
