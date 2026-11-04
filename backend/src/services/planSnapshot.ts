import type { PlanEntry } from 'michi-shared';
import type { PlanSnapshotQuery } from '../agents/ports';
import { resolveBranchBoundary } from './branchBoundary';
import { getNode, listMessages, type MessageRow } from './dbRepository';

/** A branch chain deeper than this is not followed further for a plan. */
const MAX_PLAN_ANCESTORS = 32;

function normalizePlan(value: unknown[]): PlanEntry[] {
  return value.map((entry) => {
    const raw = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    return {
      content: String(raw.content ?? ''),
      priority: raw.priority === 'high' || raw.priority === 'low' ? raw.priority : 'medium',
      status: raw.status === 'in_progress' || raw.status === 'completed' ? raw.status : 'pending',
    };
  });
}

/**
 * The last plan recorded in a message list. Only an assistant row whose turn
 * reported a plan has `metadata.plan`; an empty array is a cleared plan and is
 * returned as such. undefined: no row in the list reported a plan.
 */
function latestPlanSnapshot(rows: ReadonlyArray<Pick<MessageRow, 'role' | 'metadata'>>): PlanEntry[] | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.role !== 'assistant' || !row.metadata) continue;
    try {
      const plan = (JSON.parse(row.metadata) as { plan?: unknown } | null)?.plan;
      if (Array.isArray(plan)) return normalizePlan(plan);
    } catch {
      // Unreadable metadata carries no plan; keep looking further back.
    }
  }
  return undefined;
}

interface PlanCut {
  parentNodeId: string;
  rows: MessageRow[];
}

/** The parent rows a host-resolved branch inherits; undefined if the cut is gone or crosses workspaces. */
function explicitCut(nodeId: string, branch: NonNullable<PlanSnapshotQuery['branch']>, userId?: string): PlanCut | undefined {
  const child = getNode(nodeId);
  const parent = getNode(branch.parentNodeId);
  if (!child || !parent || child.workspace_id !== parent.workspace_id) return undefined;
  const rows = listMessages(parent.id, userId);
  if (branch.boundaryMessageId === undefined) return { parentNodeId: parent.id, rows: [] };
  const index = rows.findIndex((row) => row.id === branch.boundaryMessageId);
  return index < 0 ? undefined : { parentNodeId: parent.id, rows: rows.slice(0, index + 1) };
}

/** The parent rows a node's own branch edge inherits, through the same cut its session context uses. */
function edgeCut(nodeId: string, userId?: string): PlanCut | undefined {
  try {
    const boundary = resolveBranchBoundary({ childNodeId: nodeId, userId });
    return boundary ? { parentNodeId: boundary.parentNodeId, rows: boundary.messages } : undefined;
  } catch {
    // A missing anchor or parent inherits nothing rather than a wrong prefix.
    return undefined;
  }
}

/**
 * The plan a node's runtime session starts from. The node's own latest plan
 * wins; otherwise the branch parent's latest plan at the branch cut, walking
 * further up while an ancestor had none of its own. Never writes: a branch
 * gets a copy and its parent is left as it was.
 */
export function sessionPlanSnapshot(input: PlanSnapshotQuery): PlanEntry[] | null {
  const userId = input.userId ?? undefined;
  const own = latestPlanSnapshot(listMessages(input.nodeId, userId));
  if (own) return own;
  const visited = new Set([input.nodeId]);
  let cut = input.branch ? explicitCut(input.nodeId, input.branch, userId) : edgeCut(input.nodeId, userId);
  while (cut && !visited.has(cut.parentNodeId) && visited.size <= MAX_PLAN_ANCESTORS) {
    visited.add(cut.parentNodeId);
    const inherited = latestPlanSnapshot(cut.rows);
    if (inherited) return inherited;
    cut = edgeCut(cut.parentNodeId, userId);
  }
  return null;
}
