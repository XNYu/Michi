import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { chatHub } from '../src/agents/chatHub';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';

// The hub's live/replay/owner behavior is covered by chatHubSelfTurn. This
// boundary test verifies negotiation and wire encoding on the real HTTP route.
test('background HTTP subscription negotiates foreground envelopes without changing self-turn frames', async (t) => {
  const previousCloud = process.env.MICHI_CLOUD;
  process.env.MICHI_CLOUD = '1';
  const detach = t.mock.fn();
  const subscribe = t.mock.method(chatHub, 'subscribeBackground', (sub: Parameters<typeof chatHub.subscribeBackground>[0]) => {
    assert.equal(sub.includeForeground, true);
    assert.equal(sub.ownerUserId, 'alice');
    sub.send('n', { event: 'turn_start', data: { chatId: 'n', nodeId: 'n', turnId: 'phone', assistantId: 'a-phone', seq: 0, userText: 'from phone' } }, false);
    sub.send('n', { event: 'chunk', data: { chatId: 'n', nodeId: 'n', turnId: 'self', assistantId: 'a-self', seq: 1, text: 'automatic' } }, true);
    return detach;
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: 'alice' }; next(); });
  app.use('/api', setupMichiRoutes({} as ChatManager));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    subscribe.mock.restore();
    if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/chats/background/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ includeForeground: true, cursors: {} }), signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let body = '';
  while (!body.includes('automatic')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    body += new TextDecoder().decode(value);
  }
  const frames = body.trim().split('\n\n');
  assert.equal(frames[0].split('\n')[0], 'event: foreground_event');
  assert.deepEqual(JSON.parse(frames[0].split('\ndata: ')[1]), {
    event: 'turn_start', data: { chatId: 'n', nodeId: 'n', turnId: 'phone', assistantId: 'a-phone', seq: 0, userText: 'from phone' },
  });
  assert.equal(frames[1].split('\n')[0], 'event: chunk');
  await reader.cancel();
});
