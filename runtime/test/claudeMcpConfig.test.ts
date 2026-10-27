/**
 * Unit tests for claudeMcpConfig.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeMcpConfig, MICHI_INTERNAL_MCP_NAME } from '../src/adapters/claude/claudeMcpConfig';

describe('claudeMcpConfig', () => {

  // Case 5: type is 'http'
  test('buildClaudeMcpConfig sets type to http', () => {
    const json = buildClaudeMcpConfig({ url: 'http://127.0.0.1:9000/api/mcp/slot-type' });
    const parsed = JSON.parse(json);
    assert.equal(parsed.mcpServers[MICHI_INTERNAL_MCP_NAME].type, 'http');
  });

  test("buildClaudeMcpConfig takes the slot endpoint's URL and no headers", () => {
    const endpoint = { type: 'http' as const, url: 'http://127.0.0.1:9000/api/mcp/slot-a', headers: [] };
    assert.deepEqual(JSON.parse(buildClaudeMcpConfig(endpoint)), {
      mcpServers: { [MICHI_INTERNAL_MCP_NAME]: { type: 'http', url: endpoint.url } },
    });
    assert.deepEqual(JSON.parse(buildClaudeMcpConfig(endpoint, { alwaysLoad: true })).mcpServers[MICHI_INTERNAL_MCP_NAME],
      { type: 'http', url: endpoint.url, alwaysLoad: true });
  });
});
