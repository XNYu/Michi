import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentProviderInfo, ModelInfo, RuntimeId } from './types';

const CACHE_VERSION = 2;

interface CatalogSnapshot {
  version: number;
  runtimeId: RuntimeId;
  provider?: string;
  updatedAt: number;
  contentHash: string;
  models: ModelInfo[];
  providers: AgentProviderInfo[];
}

/**
 * Backward-compat: v1 snapshots only had `models`. Loaded transparently
 * with `providers: []`.
 */
interface ModelCacheSnapshotV1 {
  version: 1;
  runtimeId: RuntimeId;
  updatedAt: number;
  models: ModelInfo[];
}

export interface RuntimeModelCache {
  load(runtimeId: RuntimeId): ModelInfo[] | null;
  save(runtimeId: RuntimeId, models: ModelInfo[]): void;
}

export interface RuntimeCatalogCache extends RuntimeModelCache {
  loadCatalog(runtimeId: RuntimeId, provider?: string): CatalogSnapshot | null;
  saveCatalog(
    runtimeId: RuntimeId,
    data: { models: ModelInfo[]; providers: AgentProviderInfo[] },
    provider?: string,
  ): { written: boolean; snapshot: CatalogSnapshot };
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

function sanitizeProviders(value: unknown): AgentProviderInfo[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is AgentProviderInfo =>
      !!item && typeof item === 'object' && typeof (item as any).id === 'string',
  );
}

function computeContentHash(models: ModelInfo[], providers: AgentProviderInfo[]): string {
  const modelIds = models.map((m) => m.id).sort();
  const providerIds = providers.map((p) => p.id).sort();
  const defaultModel = models.find((m) => m.isDefault)?.id ?? '';
  const payload = [...modelIds, '|', ...providerIds, '|', defaultModel].join(',');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Best-effort runtime catalog store under MICHI_DATA_DIR/runtime-models.
 *
 * v2 extends v1 with providers and a contentHash for diff-on-write:
 * the file is only overwritten when the catalog content actually changed.
 * Reads are synchronous so runtimes can expose the previous snapshot
 * immediately during construction; writes use a temp file + rename so a
 * process crash cannot leave a partially-written catalog.
 */
export class FileRuntimeCatalogCache implements RuntimeCatalogCache {
  private readonly cacheDir: string;

  constructor(dataDir: string) {
    this.cacheDir = path.join(dataDir, 'runtime-models');
  }

  // --- v1 backward-compat interface ---

  load(runtimeId: RuntimeId): ModelInfo[] | null {
    const snapshot = this.loadCatalog(runtimeId);
    return snapshot?.models ?? null;
  }

  save(runtimeId: RuntimeId, models: ModelInfo[]): void {
    this.saveCatalog(runtimeId, { models, providers: [] });
  }

  // --- v2 catalog interface ---

  loadCatalog(runtimeId: RuntimeId, provider?: string): CatalogSnapshot | null {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.cachePath(runtimeId, provider), 'utf8'),
      ) as CatalogSnapshot | ModelCacheSnapshotV1;

      if (raw.runtimeId !== runtimeId) return null;

      // v1 → v2 transparent upgrade
      if (raw.version === 1) {
        const models = sanitizeModels(raw.models);
        if (!models) return null;
        return {
          version: CACHE_VERSION,
          runtimeId,
          provider,
          updatedAt: raw.updatedAt,
          contentHash: computeContentHash(models, []),
          models,
          providers: [],
        };
      }

      if (raw.version !== CACHE_VERSION) return null;
      const models = sanitizeModels(raw.models);
      if (!models) return null;
      return {
        ...raw,
        models,
        providers: sanitizeProviders(raw.providers),
      };
    } catch {
      return null;
    }
  }

  saveCatalog(
    runtimeId: RuntimeId,
    data: { models: ModelInfo[]; providers: AgentProviderInfo[] },
    provider?: string,
  ): { written: boolean; snapshot: CatalogSnapshot } {
    const sanitized = sanitizeModels(data.models);
    const providers = sanitizeProviders(data.providers);
    const models = sanitized ?? [];
    const contentHash = computeContentHash(models, providers);

    // Diff-on-write: skip if content hasn't changed
    const existing = this.loadCatalog(runtimeId, provider);
    if (existing && existing.contentHash === contentHash) {
      return { written: false, snapshot: existing };
    }

    const snapshot: CatalogSnapshot = {
      version: CACHE_VERSION,
      runtimeId,
      provider,
      updatedAt: Date.now(),
      contentHash,
      models,
      providers,
    };

    // Only write if there are models (or providers) to persist
    if (models.length === 0 && providers.length === 0) {
      return { written: false, snapshot };
    }

    const target = this.cachePath(runtimeId, provider);
    const temporary = `${target}.${process.pid}.tmp`;

    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, target);
      return { written: true, snapshot };
    } catch (err) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      console.warn(`[runtimeCatalogCache] Failed to persist ${runtimeId} catalog:`, (err as Error).message);
      return { written: false, snapshot };
    }
  }

  private cachePath(runtimeId: RuntimeId, provider?: string): string {
    const safeId = String(runtimeId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const suffix = provider ? `_${provider.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
    return path.join(this.cacheDir, `${safeId}${suffix}.json`);
  }
}
