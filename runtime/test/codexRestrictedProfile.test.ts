import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_RESTRICTED_FEATURES_OFF,
  CODEX_RESTRICTED_TURN_POLICY,
  codexRestrictedMcpCheck,
  codexRestrictedThreadConfig,
  codexThreadSandbox,
} from '../src/adapters/codex/codexRestrictedProfile';
import { buildCodexMcpConfig, CODEX_HOST_MCP_SERVER } from '../src/adapters/codex/codexProtocol';

describe('Codex restricted profile', () => {
  it('runs a restricted turn read-only and offline', () => {
    assert.deepEqual(CODEX_RESTRICTED_TURN_POLICY, { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    assert.ok(Object.isFrozen(CODEX_RESTRICTED_TURN_POLICY) && Object.isFrozen(CODEX_RESTRICTED_TURN_POLICY.sandboxPolicy));
  });

  it('starts a thread read-only exactly when the host restricts it', () => {
    assert.equal(codexThreadSandbox(true), 'read-only');
    assert.equal(codexThreadSandbox(false), 'workspace-write');
  });

  it("names the host's MCP server as the session config does", () => {
    assert.equal(CODEX_HOST_MCP_SERVER, '__michi_internal__');
    const config = buildCodexMcpConfig({ url: 'http://127.0.0.1:1/mcp', headers: {} } as never);
    assert.deepEqual(Object.keys(config.mcp_servers as object), [CODEX_HOST_MCP_SERVER]);
  });

  it('turns features and web search off and disables every MCP server but the host\'s', () => {
    const host = { url: 'http://127.0.0.1:1/mcp' };
    const base = { mcp_servers: { [CODEX_HOST_MCP_SERVER]: host }, features: { hooks: true }, hooks: { Stop: [] } };
    const config = codexRestrictedThreadConfig(base, ['user-server', CODEX_HOST_MCP_SERVER]);
    assert.deepEqual(config, {
      ...base,
      features: { hooks: true, ...CODEX_RESTRICTED_FEATURES_OFF },
      web_search: 'disabled',
      mcp_servers: { 'user-server': { enabled: false }, [CODEX_HOST_MCP_SERVER]: host },
    });
    assert.ok(Object.values(CODEX_RESTRICTED_FEATURES_OFF).every((value) => value === false));
    assert.equal(CODEX_RESTRICTED_FEATURES_OFF.shell_tool, false);
  });

  it('passes a thread only when the host\'s server is listed and every other one is disabled', () => {
    const own = { name: CODEX_HOST_MCP_SERVER, runtimeStatus: 'connected' };
    assert.deepEqual(codexRestrictedMcpCheck([own, { name: 'user-server', runtimeStatus: 'disabled' }]), { ok: true });
    const open = codexRestrictedMcpCheck([own, { name: 'user-server', runtimeStatus: 'connected' }]);
    assert.deepEqual(open, { ok: false, open: ['user-server'], fatal: false, reason: 'MCP servers Michi could not turn off: user-server' });
    for (const statuses of [null, [], [{ name: 'user-server', runtimeStatus: 'disabled' }]]) {
      const check = codexRestrictedMcpCheck(statuses);
      assert.equal(check.ok, false);
      assert.equal(!check.ok && check.fatal, true);
    }
  });
});
