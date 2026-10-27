import type { ModelInfo } from '../contract/types';

export interface RuntimeModelCatalogOptions<ProbeResult> {
  initial?: ModelInfo[] | null;
  probe: () => Promise<ProbeResult>;
  normalize: (result: ProbeResult) => ModelInfo[];
  persist?: (models: ModelInfo[]) => void;
  onUpdate?: (models: ModelInfo[]) => void;
  fallback?: () => ModelInfo[];
}

/**
 * Owns the last usable dynamic catalog and a single in-flight refresh. Probe
 * cost and refresh triggers belong to the runtime; failures remain observable.
 */
export class RuntimeModelCatalog<ProbeResult = ModelInfo[]> {
  private snapshot: ModelInfo[] | null;
  private pending: Promise<ModelInfo[]> | null = null;

  constructor(private readonly options: RuntimeModelCatalogOptions<ProbeResult>) {
    this.snapshot = options.initial?.length ? options.initial : null;
    if (this.snapshot) options.onUpdate?.(this.snapshot);
  }

  get cached(): ModelInfo[] | null { return this.snapshot; }
  get refreshing(): boolean { return this.pending !== null; }

  current(): ModelInfo[] { return this.snapshot ?? this.options.fallback?.() ?? []; }

  /** Also accepts catalogs learned incidentally during native session setup. */
  replace(result: ProbeResult): ModelInfo[] {
    const models = this.options.normalize(result);
    if (models.length) {
      this.snapshot = models;
      this.options.onUpdate?.(models);
      this.options.persist?.(models);
    }
    return this.current();
  }

  refresh(): Promise<ModelInfo[]> {
    if (this.pending) return this.pending;
    const refresh = async () => this.replace(await this.options.probe());
    this.pending = refresh().finally(() => { this.pending = null; });
    return this.pending;
  }
}
