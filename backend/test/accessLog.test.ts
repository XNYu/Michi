import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldLogAccess } from '../src/services/accessLog';

test('Pages no-change polls are quiet while changed reads and writes remain logged', () => {
  for (const prefix of ['', '/api']) {
    for (const pathname of ['/spaces', '/pages/page-1', '/pages/page-1/changes', '/databases/db-1', '/workspaces/ws/pages']) {
      assert.equal(shouldLogAccess('GET', prefix + pathname, 204), false);
      assert.equal(shouldLogAccess('GET', prefix + pathname, 304), false);
      assert.equal(shouldLogAccess('GET', prefix + pathname, 200), true);
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        assert.equal(shouldLogAccess(method, prefix + pathname, 204), true);
      }
    }
  }
  assert.equal(shouldLogAccess('POST', '/api/pages/pg/edits', 200), true);
  assert.equal(shouldLogAccess('POST', '/workspaces/ws/open-url/claim', 200), true);
  assert.equal(shouldLogAccess('GET', '/unrelated', 304), true);
});

test('all polling and legacy silent paths retain errors', () => {
  const routes = ['/health', '/agent/status', '/ready', '/mcp/slot', '/nodes/node/ensure-session',
    '/workspaces/all', '/chats/chat/heartbeat', '/pages/page', '/spaces', '/backend-connections/recovery'];
  for (const pathname of routes) {
    for (const status of [400, 401, 404, 429, 500, 503]) {
      assert.equal(shouldLogAccess('GET', `/api${pathname}`, status), true, `${pathname}: ${status}`);
    }
  }
  assert.equal(shouldLogAccess('GET', '/backend-connections/recovery', 200), false);
  assert.equal(shouldLogAccess('GET', '/api/ready', 200), false);
});
