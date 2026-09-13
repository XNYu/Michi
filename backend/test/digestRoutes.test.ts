import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { setupDigestRoutes } from '../src/routes/digests';
import type { ChatManager } from '../src/services/chatManager';

describe('digest SSE routes', () => {
  it('sends thinking and activity before final markdown over HTTP', async () => {
    const manager = {
      async newChat() { return 'test-session'; },
      async *sendMessage() {
        yield { kind: 'thought', text: 'Comparing sources' };
        yield { kind: 'chunk', text: '# Summary' };
        yield { kind: 'turn_end' };
      },
    } as unknown as ChatManager;
    const app = express();
    app.use(express.json());
    app.use('/api', setupDigestRoutes(manager));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/digests/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: { name: 'Test', createdAt: 1 }, rootTitle: 'Topic', nodes: [{ nodeId: 's1', depth: 0, messages: [] }] }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /event: status\ndata: {"text":"Preparing digest\.\.\."}/);
      assert.match(text, /event: thought\ndata: {"text":"Comparing sources"}/);
      assert.match(text, /event: done\ndata: {"markdown":"# Summary"}/);
      assert.ok(text.indexOf('event: thought') < text.indexOf('event: done'));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
