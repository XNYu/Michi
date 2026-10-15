import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UrlOpenRequests } from '../src/services/urlOpenRequests';

const scope = { workspaceId: 'workspace', treeId: 'tree', ownerUserId: 'alice' };
describe('agent URL requests', () => {
  it('isolates owner, workspace and tree and consumes each request once', () => {
    const queue = new UrlOpenRequests();
    queue.enqueue(scope, 'https://example.com', 100);
    for (const other of [{ ...scope, ownerUserId: 'bob' }, { ...scope, workspaceId: 'other' }, { ...scope, treeId: 'other' }]) {
      assert.equal(queue.claim(other, 101), null);
    }
    assert.equal(queue.claim(scope, 101)?.url, 'https://example.com/');
    assert.equal(queue.claim(scope, 101), null);
  });
  it('expires stale requests instead of reopening on a later visit', () => {
    const queue = new UrlOpenRequests();
    queue.enqueue(scope, 'http://localhost:8080', 100);
    assert.equal(queue.claim(scope, 30100), null);
  });
  it('rejects unsafe URLs and bounds pending work', () => {
    const queue = new UrlOpenRequests();
    for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://user:secret@example.com', 'no url']) {
      assert.throws(() => queue.enqueue(scope, url, 100));
    }
    for (let i = 0; i < 8; i++) queue.enqueue(scope, 'https://example.com', 100);
    assert.throws(() => queue.enqueue(scope, 'https://example.com', 100));
  });
});
