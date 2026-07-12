import fs from 'node:fs';
import path from 'node:path';
import type { ModelInfo, RuntimeId } from './types';

const CACHE_VERSION = 1;

interface ModelCacheSnapshot {
  version: number;
  runtimeId: RuntimeId;
  updatedAt: number;
  models: ModelInfo[];
}
export interface RuntimeModelCache {
  load(runtimeId: RuntimeId): ModelInfo[] | null;
  save(runtimeId: RuntimeId, models: ModelInfo[]): void;
}

function sanitizeModels(value: unknown): ModelInfo[] | null {
  if (!Array.isArray(value)) return null;

  const models = value
    .map((item): ModelInfo | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      if (typeof raw.id !== 'string' || !raw.id) return null;
      return {
        id: raw.id,
        label: typeof raw.label === 'string' ? raw.label : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
        isDefault: raw.isDefault === true ? true : undefined,
      };
    })
    .filter((model): model is ModelInfo => model !== null);

  return models.length > 0 ? models : null;
}

/**
 * Small, best-effort model catalog store under MICHI_DATA_DIR/runtime-models.
 * Reads are synchronous so runtimes can expose the previous snapshot
 * immediately during construction; writes use a temp file + rename so a
 * process crash cannot leave a partially-written catalog.
 */
export class FileRuntimeModelCache implements RuntimeModelCache {
  private readonly cacheDir: string;

  constructor(dataDir: string) {
    this.cacheDir = path.join(dataDir, 'runtime-models');
  }

  load(runtimeId: RuntimeId): ModelInfo[] | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath(runtimeId), 'utf8')) as ModelCacheSnapshot;
      if (parsed.version !== CACHE_VERSION || parsed.runtimeId !== runtimeId) return null;
      return sanitizeModels(parsed.models);
    } catch {
      return null;
    }
  }

  save(runtimeId: RuntimeId, models: ModelInfo[]): void {
    const sanitized = sanitizeModels(models);
    if (!sanitized) return;

    const target = this.cachePath(runtimeId);
    const temporary = `${target}.${process.pid}.tmp`;
    const snapshot: ModelCacheSnapshot = {
      version: CACHE_VERSION,
      runtimeId,
      updatedAt: Date.now(),
      models: sanitized,
    };

    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, target);
    } catch (err) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      console.warn(`[runtimeModelCache] Failed to persist ${runtimeId} models:`, (err as Error).message);
    }
  }

  private cachePath(runtimeId: RuntimeId): string {
    const safeId = String(runtimeId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.cacheDir, `${safeId}.json`);
  }
}
