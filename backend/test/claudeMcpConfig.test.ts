/**
 * Unit tests for claudeMcpConfig.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeMcpConfig, MICHI_INTERNAL_MCP_NAME } from '../src/agents/claude/claudeMcpConfig';

describe('claudeMcpConfig', () => {

  // Case 1: returns parseable JSON with the expected mcpServers shape
  test('buildClaudeMcpConfig returns valid JSON parseable to expected mcpServers shape', () => {
    const json = buildClaudeMcpConfig('slot-abc', 9876);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, {
      mcpServers: {
        [MICHI_INTERNAL_MCP_NAME]: {
          type: 'http',
          url: 'http://127.0.0.1:9876/api/mcp/slot-abc',
        },
      },
    });
  });

  // Case 2: slotId is interpolated correctly into the URL
  test('buildClaudeMcpConfig interpolates slotId into the URL path', () => {
    const json = buildClaudeMcpConfig('my-custom-slot-xyz', 3000);
    const parsed = JSON.parse(json);
    const url: string = parsed.mcpServers[MICHI_INTERNAL_MCP_NAME].url;
    assert.ok(url.includes('/api/mcp/my-custom-slot-xyz'), `URL should contain slotId, got: ${url}`);
  });

  // Case 3: port number is included as-is
  test('buildClaudeMcpConfig includes port number verbatim in URL', () => {
    const json = buildClaudeMcpConfig('slot-port-test', 12345);
    const parsed = JSON.parse(json);
    const url: string = parsed.mcpServers[MICHI_INTERNAL_MCP_NAME].url;
    assert.ok(url.includes(':12345/'), `URL should contain port 12345, got: ${url}`);
  });

  // Case 4: MICHI_INTERNAL_MCP_NAME is the key in mcpServers
  test('buildClaudeMcpConfig uses MICHI_INTERNAL_MCP_NAME as the server key', () => {
    const json = buildClaudeMcpConfig('slot-key', 8080);
    const parsed = JSON.parse(json);
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed.mcpServers, MICHI_INTERNAL_MCP_NAME),
      `mcpServers should have key '${MICHI_INTERNAL_MCP_NAME}'`,
    );
  });

  // Case 5: type is 'http'
  test('buildClaudeMcpConfig sets type to http', () => {
    const json = buildClaudeMcpConfig('slot-type', 9000);
    const parsed = JSON.parse(json);
    assert.equal(parsed.mcpServers[MICHI_INTERNAL_MCP_NAME].type, 'http');
  });
});
