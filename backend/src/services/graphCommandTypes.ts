export interface EnsureDurableGraphNodeInput {
  workspace: {
    id: string;
    name: string;
    cwd?: string | null;
    createdAt: number;
    activeTreeId?: string | null;
    settings?: Record<string, unknown> | null;
  };
  tree?: {
    id: string;
    rootNodeId: string;
    name?: string | null;
    archivedAt?: number | null;
    pinnedAt?: number | null;
    lastActiveAt: number;
    createdAt: number;
  };
  node: {
    id: string;
    treeId?: string | null;
    parentNodeId?: string | null;
    kind?: string;
    title?: string | null;
    spawnedByAgent?: boolean;
    /** Opaque frontend-owned draft/outbox payload. */
    composerDraft?: string | null;
    currentModeId?: string | null;
    createdAt: number;
  };
  edges: ReadonlyArray<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    kind: string;
    anchorMessageId?: string | null;
    createdAt?: number | null;
  }>;
  ownerUserId?: string | null;
}
