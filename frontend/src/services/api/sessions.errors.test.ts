import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAgentModes, warmCwd } from './sessions';

afterEach(() => { vi.restoreAllMocks(); });

describe('background session request errors', () => {
  it.each(['warm', 'modes'])('preserves the status, code and actionable folder message for %s', async (operation) => {
    const message = 'Workspace folder does not exist: /old/path. Select an existing folder.';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: message, code: 'WORKSPACE_CWD_INVALID',
    }), { status: 400 }));
    const request = operation === 'warm' ? warmCwd('/old/path') : listAgentModes();
    await expect(request).rejects.toMatchObject({ status: 400, code: 'WORKSPACE_CWD_INVALID', message });
  });

  it('keeps a non-JSON response classifiable by HTTP status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Gateway unavailable', { status: 503 }));
    await expect(listAgentModes()).rejects.toMatchObject({ status: 503, message: 'listAgentModes failed: 503' });
  });

  it('passes warm cancellation to the request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    const controller = new AbortController();
    await warmCwd('/tmp', undefined, controller.signal);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});
