import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CustomAgentsFeatureGate } from '../src/services/customAgentsFeatureGate';

describe('CustomAgentsFeatureGate', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-custom-agents-feature-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('uses the supplied default until a backend setting is persisted', () => {
    assert.equal(new CustomAgentsFeatureGate({ dataDir, defaultEnabled: false }).isEnabled(), false);
    assert.equal(new CustomAgentsFeatureGate({ dataDir, defaultEnabled: true }).isEnabled(), true);
  });

  test('persists the backend setting while preserving unrelated config', () => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ agent: { runtime: 'kiro' }, unrelated: true }),
    );
    const gate = new CustomAgentsFeatureGate({ dataDir, defaultEnabled: false });

    gate.setEnabled(true);

    assert.equal(gate.isEnabled(), true);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
    assert.equal(persisted.customAgents.enabled, true);
    assert.deepEqual(persisted.agent, { runtime: 'kiro' });
    assert.equal(persisted.unrelated, true);
    assert.equal(fs.statSync(path.join(dataDir, 'config.json')).mode & 0o777, 0o600);
  });

  test('persisted backend setting overrides the environment-derived default', () => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ customAgents: { enabled: false } }),
    );

    const gate = new CustomAgentsFeatureGate({ dataDir, defaultEnabled: true });

    assert.equal(gate.isEnabled(), false);
  });

  test('malformed shared config fails closed and is never overwritten', () => {
    const configPath = path.join(dataDir, 'config.json');
    fs.writeFileSync(configPath, '{ malformed');
    const gate = new CustomAgentsFeatureGate({ dataDir, defaultEnabled: true });

    assert.equal(gate.isEnabled(), false);
    assert.throws(() => gate.setEnabled(true), /Invalid JSON/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), '{ malformed');
    assert.equal(gate.isEnabled(), false);
  });

  test('type-malformed persisted enabled value fails closed', () => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ customAgents: { enabled: 'false' } }),
    );

    const gate = new CustomAgentsFeatureGate({ dataDir, defaultEnabled: true });

    assert.equal(gate.isEnabled(), false);
  });
});
