import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getMichiDataDir } from './dataDir';

export interface CustomAgentsFeatureControl {
  isEnabled(): boolean;
  setEnabled?(enabled: boolean): void | Promise<void>;
}

export class CustomAgentsFeatureBusyError extends Error {
  readonly activeRunCount: number;

  constructor(activeRunCount: number) {
    super(`Cannot disable Custom Agents while ${activeRunCount} Agent Run${activeRunCount === 1 ? ' is' : 's are'} active`);
    this.name = 'CustomAgentsFeatureBusyError';
    this.activeRunCount = activeRunCount;
  }
}

interface CustomAgentsFeatureGateOptions {
  dataDir?: string;
  defaultEnabled?: boolean;
}

interface MichiConfigFile {
  customAgents?: {
    enabled?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function readConfig(configPath: string): MichiConfigFile {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Unable to read ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config root must be an object');
    }
    return parsed as MichiConfigFile;
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeConfigAtomically(configPath: string, config: MichiConfigFile): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(config, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, configPath);
  } finally {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch { /* renamed or never created */ }
  }
}

export class CustomAgentsFeatureGate implements CustomAgentsFeatureControl {
  private readonly configPath: string;
  private enabled: boolean;

  constructor(options: CustomAgentsFeatureGateOptions = {}) {
    const dataDir = options.dataDir ?? getMichiDataDir();
    this.configPath = path.join(dataDir, 'config.json');
    try {
      const customAgents = readConfig(this.configPath).customAgents;
      if (customAgents === undefined) {
        this.enabled = options.defaultEnabled ?? process.env.MICHI_CUSTOM_AGENTS === '1';
      } else if (
        customAgents
        && typeof customAgents === 'object'
        && Object.prototype.hasOwnProperty.call(customAgents, 'enabled')
      ) {
        this.enabled = typeof customAgents.enabled === 'boolean' ? customAgents.enabled : false;
      } else if (customAgents && typeof customAgents === 'object') {
        this.enabled = options.defaultEnabled ?? process.env.MICHI_CUSTOM_AGENTS === '1';
      } else {
        this.enabled = false;
      }
    } catch {
      // A malformed or unreadable shared config must never enable a
      // tool-executing feature from its fallback default.
      this.enabled = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    const existing = readConfig(this.configPath);
    const customAgents = existing.customAgents && typeof existing.customAgents === 'object'
      ? existing.customAgents
      : {};
    const next: MichiConfigFile = {
      ...existing,
      customAgents: { ...customAgents, enabled },
    };

    writeConfigAtomically(this.configPath, next);
    this.enabled = enabled;
  }
}
