/** Shared presentation contracts for Michi's built-in content UI. */
export type MichiThreadState = 'waiting' | 'stalled' | 'doing' | 'done' | 'idea';

/** Optional state metadata for a database row. */
export interface DatabaseRowStatus {
  state: MichiThreadState;
  doneBy?: 'user' | 'agent';
}

/** Renderer input; native Pages validates persisted blocks against its catalog. */
export interface MichiPageBlock {
  type: string;
  id?: string;
  [field: string]: unknown;
}

/** Quoted interface material handed to the Michi assistant. */
export interface MichiContextItem {
  kind: 'thread' | 'block' | 'row' | 'node';
  id: string;
  title: string;
  text?: string;
  projectId?: string;
}
