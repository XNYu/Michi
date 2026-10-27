import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_RESTRICTED_DISALLOWED_TOOLS,
  claudeSpawnPolicy,
  restrictedToolApproval,
} from '../src/adapters/claude/claudeRestrictedProfile';
import { getClaudeProjectsDir } from '../src/adapters/claude/claudeProjectsPath';
import { createDefaultHost } from '../src/core/defaultHost';

describe('Claude restricted profile', () => {
  it('leaves an unrestricted session to its permission mode', () => {
    const allowed = { allowedToolNames: ['read'] };
    assert.deepEqual(claudeSpawnPolicy(false, { ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: undefined }), { permissionMode: 'bypassPermissions' });
    // A session restricted by a tool profile, or an Agent Run, never bypasses.
    assert.deepEqual(claudeSpawnPolicy(false, { ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: allowed }), { permissionMode: 'default' });
    assert.deepEqual(claudeSpawnPolicy(false, { ownerMode: 'headless', permissionMode: 'yolo', toolProfile: undefined }), { permissionMode: 'default' });
    assert.deepEqual(claudeSpawnPolicy(false, { ownerMode: 'interactive', permissionMode: 'ask', toolProfile: undefined }), { permissionMode: 'default' });
  });

  it('locks a restricted session down whatever its owner and permission mode', () => {
    const restricted = { allowedToolNames: ['list_threads'], restricted: true };
    for (const permissionMode of ['yolo', 'trust', 'ask', undefined] as const) {
      for (const ownerMode of ['interactive', 'headless'] as const) {
        const policy = claudeSpawnPolicy(true, { ownerMode, permissionMode, toolProfile: restricted });
        assert.equal(policy.permissionMode, 'default');
        assert.deepEqual(policy.tools, []);
        assert.equal(policy.disallowedTools, CLAUDE_RESTRICTED_DISALLOWED_TOOLS);
        assert.ok(policy.disallowedTools?.includes('Bash') && policy.disallowedTools.includes('Write') && policy.disallowedTools.includes('WebFetch'));
        assert.equal(policy.strictMcpConfig, true);
        assert.equal(policy.isolateSettings, true);
        assert.equal(policy.restrictedMode, true);
      }
    }
    assert.ok(Object.isFrozen(CLAUDE_RESTRICTED_DISALLOWED_TOOLS));
  });

  it('follows the host verdict rather than the flag, so a host that restricts more locks more', () => {
    const policy = claudeSpawnPolicy(true, { ownerMode: 'interactive', permissionMode: 'yolo', toolProfile: undefined });
    assert.equal(policy.permissionMode, 'default');
    assert.deepEqual(policy.tools, []);
    assert.equal(policy.restrictedMode, true);
    assert.deepEqual(claudeSpawnPolicy(false, { ownerMode: 'interactive', permissionMode: 'ask', toolProfile: { restricted: true } }), { permissionMode: 'default' });
  });

  it('denies every tool call of a restricted session unless the options allow it', () => {
    assert.equal(restrictedToolApproval({}, 'list_threads'), 'deny');
    assert.equal(restrictedToolApproval({}, null), 'deny');
    const seen: Array<string | null> = [];
    const options = { restrictedToolApproval: (name: string | null) => { seen.push(name); return name === 'list_threads' ? 'allow' as const : 'deny' as const; } };
    assert.equal(restrictedToolApproval(options, 'list_threads'), 'allow');
    assert.equal(restrictedToolApproval(options, null), 'deny');
    assert.deepEqual(seen, ['list_threads', null]);
  });
});

describe('Claude adapter configDir', () => {
  const host = createDefaultHost({ logLevel: 'silent' });

  it('without one, the profile is the environment\'s CLAUDE_CONFIG_DIR', () => {
    const dir = getClaudeProjectsDir({ host, spawnEnv: () => ({ CLAUDE_CONFIG_DIR: '/env-profile' }) }, '/w');
    assert.equal(dir, '/env-profile/projects/-w');
  });

  it('an override wins over the environment', () => {
    const dir = getClaudeProjectsDir({ host, spawnEnv: () => ({ CLAUDE_CONFIG_DIR: '/env-profile' }), configDir: () => '/cfg' }, '/w');
    assert.equal(dir, '/cfg/projects/-w');
  });
});
