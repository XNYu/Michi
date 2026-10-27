import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CUSTOM_AGENTS_ENV, CustomAgentsFeatureGate } from '../src/services/customAgentsFeatureGate';

describe('CustomAgentsFeatureGate', () => {

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

    test('a persisted customAgents.enabled=false does not disable an environment opt-in', () => {
      fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ customAgents: { enabled: false } }));
      process.env[CUSTOM_AGENTS_ENV] = '1';

      assert.equal(new CustomAgentsFeatureGate().isEnabled(), true);
    });
  });
});
