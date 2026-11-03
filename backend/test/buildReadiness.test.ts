import test from 'node:test';
import assert from 'node:assert/strict';
const { BuildReadiness } = require('../scripts/buildReadiness.mjs');

test('server startup waits for SDK and main output in either completion order', () => {
  for (const order of [['server', 'sdk'], ['sdk', 'server']]) {
    const readiness = new BuildReadiness(['server', 'sdk']);
    assert.equal(readiness.ready, false);
    readiness.succeeded(order[0]);
    assert.equal(readiness.ready, false);
    readiness.succeeded(order[1]);
    assert.equal(readiness.ready, true);
  }
});

test('SDK changes require successful rebuilding before either output can restart the server', () => {
  const readiness = new BuildReadiness([]);
  readiness.started('sdk');
  readiness.started('server');
  readiness.succeeded('server');
  assert.equal(readiness.ready, false, 'a failed SDK build keeps the previous process');
  readiness.started('sdk');
  readiness.succeeded('sdk');
  assert.equal(readiness.ready, true, 'SDK completion can now request the controlled restart');
});
