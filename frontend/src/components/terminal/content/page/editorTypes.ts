import type { MichiPageBlock } from 'michi-shared';

export type MichiNoticeTone = 'success' | 'info' | 'error';

export type MichiPageEditOp =
  | { op: 'delete'; id: string }
  | { op: 'update'; id: string; block: MichiPageBlock }
  | { op: 'move'; id: string; after: string | null; parent?: { id: string; slot: number } | null }
  | { op: 'insert'; after: string | null; parent?: { id: string; slot: number } | null; block: MichiPageBlock }
  | { op: 'release'; id: string };
