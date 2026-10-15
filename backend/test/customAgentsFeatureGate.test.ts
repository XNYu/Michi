import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CUSTOM_AGENTS_ENV, CustomAgentsFeatureGate } from '../src/services/customAgentsFeatureGate';

describe('CustomAgentsFeatureGate', () => {
  test('is off when the environment variable is not set', () => {
    assert.equal(new CustomAgentsFeatureGate({}).isEnabled(), false);
  });

  test('is on only for the exact value 1', () => {
    assert.equal(new CustomAgentsFeatureGate({ [CUSTOM_AGENTS_ENV]: '1' }).isEnabled(), true);
    for (const value of ['', '0', 'true', 'TRUE', 'yes', 'on', ' 1', '1 ', '01']) {
      assert.equal(
        new CustomAgentsFeatureGate({ [CUSTOM_AGENTS_ENV]: value }).isEnabled(),
        false,
        `${JSON.stringify(value)} must not enable the feature`,
      );
    }
  });

  test('reads the environment once, at construction', () => {
    const env: NodeJS.ProcessEnv = {};
    const gate = new CustomAgentsFeatureGate(env);
    env[CUSTOM_AGENTS_ENV] = '1';
    assert.equal(gate.isEnabled(), false);
  });

  test('exposes no way to change the state after startup', () => {
    const gate = new CustomAgentsFeatureGate({}) as unknown as Record<string, unknown>;
    assert.equal(typeof gate.setEnabled, 'undefined');
  });

  describe('with a config.json left by an earlier build', () => {
    let dataDir: string;
    let previousDataDir: string | undefined;
    let previousFlag: string | undefined;

    beforeEach(() => {
      dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-custom-agents-feature-'));
      previousDataDir = process.env.MICHI_DATA_DIR;
      previousFlag = process.env[CUSTOM_AGENTS_ENV];
      process.env.MICHI_DATA_DIR = dataDir;
      delete process.env[CUSTOM_AGENTS_ENV];
    });

    afterEach(() => {
      if (previousDataDir === undefined) delete process.env.MICHI_DATA_DIR;
      else process.env.MICHI_DATA_DIR = previousDataDir;
      if (previousFlag === undefined) delete process.env[CUSTOM_AGENTS_ENV];
      else process.env[CUSTOM_AGENTS_ENV] = previousFlag;
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    // The in-app switch used to persist `customAgents.enabled`. A value saved
    // back then must not keep the feature on.
    test('a persisted customAgents.enabled=true does not enable the feature', () => {
      const configPath = path.join(dataDir, 'config.json');
      const saved = JSON.stringify({ customAgents: { enabled: true }, agent: { runtime: 'kiro' } });
      fs.writeFileSync(configPath, saved);

      assert.equal(new CustomAgentsFeatureGate().isEnabled(), false);
      // ...and the gate leaves the user's config file alone.
      assert.equal(fs.readFileSync(configPath, 'utf8'), saved);
    });

    test('a persisted customAgents.enabled=false does not disable an environment opt-in', () => {
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ customAgents: { enabled: false } }));
      process.env[CUSTOM_AGENTS_ENV] = '1';

      assert.equal(new CustomAgentsFeatureGate().isEnabled(), true);
    });
  });
});
