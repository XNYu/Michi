import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { findOpenPort, isPortAvailable } from './find-open-port.mjs';

async function listenOnRandomPort(t) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test('reports a listening port as unavailable', async (t) => {
  const port = await listenOnRandomPort(t);
  assert.equal(await isPortAvailable(port), false);
});

test('findOpenPort skips an occupied starting port', async (t) => {
  const port = await listenOnRandomPort(t);
  assert.equal(await findOpenPort(port, { maxAttempts: 2 }), port + 1);
});

test('rejects invalid ranges and exhausted searches', async (t) => {
  await assert.rejects(findOpenPort(0), /between 1 and 65535/);
  const port = await listenOnRandomPort(t);
  await assert.rejects(findOpenPort(port, { maxAttempts: 1 }), /No open port found/);
});
