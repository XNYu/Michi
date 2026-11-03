/** Gate a dev-server restart until every separately emitted module is ready. */
export class BuildReadiness {
  constructor(names) { this.pending = new Set(names); }
  started(name) { this.pending.add(name); }
  succeeded(name) { this.pending.delete(name); }
  get ready() { return this.pending.size === 0; }
}
