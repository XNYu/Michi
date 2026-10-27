import os from 'node:os';
import path from 'node:path';
import { getMichiDataDir } from './dataDir';

/** Paths for preferences and runtime configuration, including Pi MCP settings.
 * Call at module initialization so an existing backend keeps its selected profile.
 * Credential and connection stores have their own path contracts.
 */
export function getMichiConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): { configDir: string; configPath: string } {
  const configDir = env.MICHI_CONFIG_DIR || path.join(homeDir, '.michi');
  return { configDir, configPath: path.join(configDir, 'config.json') };
}

/** Credentials intentionally remain shared between selected desktop profiles. */
export function getMichiCredentialConfigPaths(homeDir: string = os.homedir()): { configDir: string; configPath: string } {
  return getMichiConfigPaths({}, homeDir);
}

/** Remote connections belong to the selected data directory, not the UI profile. */
export function getMichiConnectionConfigPath(): string {
  return path.join(getMichiDataDir(), 'config.json');
}
