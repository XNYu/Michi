import { getDb } from './db';
import { getNode } from './dbRepository';
import type { NodePlacementLookup } from './nodePlacement';

export const nodePlacementRepository: NodePlacementLookup = {
  getNode,
  getTree: (id) => getDb().prepare('SELECT workspace_id FROM trees WHERE id = ?')
    .get(id) as { workspace_id: string } | undefined,
};
