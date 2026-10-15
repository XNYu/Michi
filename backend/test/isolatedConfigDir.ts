/**
 * Side-effect import for tests that exercise agentConfig / prefsConfig
 * through their real write paths (/agent/options, ensure-session,
 * updateAgentConfig). Both modules resolve config.json once, at load time,
 * from MICHI_CONFIG_DIR (default ~/.michi). Without this, those writes land
 * in the developer's real config and silently replace the app's saved
 * runtime, model and effort.
 *
 * Import it FIRST, before anything that loads src/services/agentConfig or
 * src/services/prefsConfig. It always overrides MICHI_CONFIG_DIR, because a
 * caller's value (e.g. a preview profile) is user data too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const isolatedConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-test-config-'));
process.env.MICHI_CONFIG_DIR = isolatedConfigDir;

process.on('exit', () => {
  fs.rmSync(isolatedConfigDir, { recursive: true, force: true });
});
