import { afterEach, expect, it, vi } from 'vitest';
import { connectRemoteDesktop, RemoteConnectionFailure } from './backendConnections';

afterEach(() => vi.unstubAllGlobals());

function stream(parts: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(encoder.encode(part));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

it('consumes progress and setup results split across network chunks', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => stream([
    '{"type":"pro', 'gress","message":"Building…"}\n{"type":"result","res',
    'ult":{"kind":"install_required","host":"build+"}}',
  ])));
  const progress = vi.fn();
  expect(await connectRemoteDesktop('build+', false, progress)).toEqual({ kind: 'install_required', host: 'build+' });
  expect(progress).toHaveBeenCalledWith('Building…');
});

it('surfaces setup errors and rejects streams that end without a result', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => stream(['{"type":"error","message":"Sign in with ssh build+"}\n'])));
  await expect(connectRemoteDesktop('build+', false, () => {})).rejects.toThrow('Sign in with ssh build+');
  vi.stubGlobal('fetch', vi.fn(async () => stream(['{"type":"progress","message":"Connecting"}\n'])));
  await expect(connectRemoteDesktop('build+', false, () => {})).rejects.toThrow('before setup completed');
});


it('preserves structured server diagnostics and failed stages', async () => {
  const diagnostic = { id: 'attempt-1', host: 'build+', stage: 'tunnel', startedAt: 'now', code: 'setup_failed', message: 'EADDRINUSE', log: 'SSH forwarding failed', truncated: false };
  vi.stubGlobal('fetch', vi.fn(async () => stream([JSON.stringify({ type: 'error', message: diagnostic.message, diagnostic }) + '\n'])));
  try { await connectRemoteDesktop('build+', false, () => {}); throw new Error('expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(RemoteConnectionFailure); expect((error as RemoteConnectionFailure).diagnostic).toEqual(diagnostic); }
});

it('retrieves persisted diagnostics after a stream ends without a result', async () => {
  const diagnostic = { id: 'attempt-1', host: 'build+', stage: 'source', startedAt: 'now', log: 'repository access denied', truncated: false };
  const fetcher = vi.fn().mockResolvedValueOnce(stream([
    '{"type":"attempt","id":"attempt-1"}\n{"type":"progress","stage":"source","message":"Fetching source"}\n',
  ])).mockResolvedValueOnce(new Response(JSON.stringify(diagnostic)));
  vi.stubGlobal('fetch', fetcher);
  try { await connectRemoteDesktop('build+', false, () => {}); throw new Error('expected rejection'); }
  catch (error) { expect((error as RemoteConnectionFailure).diagnostic.log).toContain('repository access denied'); }
  expect(fetcher.mock.calls[1][0]).toContain('/diagnostics/attempt-1');
});

it('retains the received timeline when both streaming and log retrieval fail', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(stream([
    '{"type":"attempt","id":"attempt-1"}\n{"type":"progress","stage":"build","message":"Building remotely"}\n',
  ])).mockRejectedValueOnce(new TypeError('gateway offline')));
  try { await connectRemoteDesktop('build+', false, () => {}); throw new Error('expected rejection'); }
  catch (error) { const report = (error as RemoteConnectionFailure).diagnostic; expect(report.stage).toBe('build'); expect(report.log).toContain('Building remotely'); expect(report.log).toContain('gateway offline'); }
});
