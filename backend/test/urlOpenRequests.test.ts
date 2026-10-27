import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UrlOpenRequests } from '../src/services/urlOpenRequests';

const scope = { workspaceId: 'workspace', treeId: 'tree', ownerUserId: 'alice' };
describe('agent URL requests', () => {
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
