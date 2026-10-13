import { afterEach, expect, it, vi } from 'vitest';
import { connectRemoteDesktop } from './backendConnections';

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
