// Manually verified; no unit tests yet — backend lacks vitest setup.
// Refactor to add tests when introducing backend test infra.

import type { DatabaseSync } from 'node:sqlite';

export interface TopologyResult {
  topology: string;
  nodeCount: number;
  truncated: boolean;
}

// kiro-cli rejects oversized tool results. Be conservative here — Chinese
// titles can blow through a naive byte budget faster than ASCII because
// each char costs 3 UTF-8 bytes but ~1 token, and the JSON envelope adds
// further overhead. Empirically 4 KB stays comfortably under the cap.
const SIZE_CAP = 4 * 1024;
// Final hard ceiling applied to the assembled output regardless of which
// trimming branch ran. Slightly larger than SIZE_CAP to avoid double-trim.
const HARD_CEILING = 6 * 1024;

interface NodeRecord {
  id: string;
  parent_node_id: string | null;
  kind: string;
  title: string | null;
  tree_id: string | null;
  deleted_at: number | null;
}

interface TreeRecord {
  id: string;
  name: string | null;
  archived_at: number | null;
  node_count: number;
}

interface EdgeRecord {
  source_node_id: string;
  target_node_id: string;
  kind: string;
}

interface NodeJson {
  id: string;
  title: string | null;
  root?: true;
  current?: true;
  parent?: string;
  merge_sources?: string[];
  links?: string[];
}

interface ThreadJson {
  id: string;
  title: string | null;
  archived?: true;
  current?: true;
  node_count: number;
  /** Present only for the current thread or when the thread is small enough to fit. */
  nodes?: NodeJson[];
}

interface TopologyJson {
  workspace: string;
  current?: { thread: string; node: string };
  threads: ThreadJson[];
  truncated_threads?: number;
  notes?: string[];
}

function buildNodeJson(
  n: NodeRecord,
  incoming: EdgeRecord[],
  currentNodeId: string | undefined,
): NodeJson {
  const out: NodeJson = { id: n.id, title: n.title };
  if (!n.parent_node_id) out.root = true;
  if (n.id === currentNodeId) out.current = true;
  if (n.parent_node_id) out.parent = n.parent_node_id;
  const mergeSources = incoming.filter((e) => e.kind === 'merge').map((e) => e.source_node_id);
  if (mergeSources.length) out.merge_sources = mergeSources;
  const links = incoming.filter((e) => e.kind === 'link').map((e) => e.source_node_id);
  if (links.length) out.links = links;
  return out;
}

/**
 * Pure function that walks SQLite workspace data and produces a JSON
 * representation for the AI's list_threads MCP tool.
 *
 * Output shape (JSON, pretty-printed):
 *   {
 *     "workspace": "...",
 *     "current": { "thread": "t-...", "node": "n-..." },
 *     "threads": [
 *       {
 *         "id": "t-...",            // thread (a.k.a. tree) id — DO NOT pass to read_node
 *         "title": "...",
 *         "current": true,
 *         "node_count": 3,
 *         "nodes": [
 *           { "id": "n-...", "title": "...", "root": true },
 *           { "id": "n-...", "title": "...", "parent": "n-...", "current": true }
 *         ]
 *       },
 *       { "id": "t-...", "title": "...", "node_count": 8 }   // collapsed: nodes omitted
 *     ]
 *   }
 *
 * The shape disambiguates thread ids from node ids — every node entry sits
 * inside a `nodes` array and every thread entry has `node_count`. read_node
 * accepts only node ids; the JSON makes that boundary obvious.
 *
 * Excludes deleted nodes and digest-kind nodes. Skips digest-source edges.
 * If the full output exceeds SIZE_CAP, the current thread keeps its `nodes`
 * array and other threads progressively drop theirs (collapsed entries still
 * carry id/title/node_count so the model can call list_threads again with a
 * specific workspaceId or search_messages to drill in).
 */
export function buildTopology(
  db: DatabaseSync,
  workspaceId: string,
  currentNodeId?: string,
): TopologyResult {
  const wsRow = db
    .prepare('SELECT id, name FROM workspaces WHERE id = ?')
    .get(workspaceId) as unknown as { id: string; name: string } | undefined;
  if (!wsRow) {
    const payload: TopologyJson = { workspace: `(not found: ${workspaceId})`, threads: [] };
    return { topology: JSON.stringify(payload, null, 2), nodeCount: 0, truncated: false };
  }

  const allTrees = db
    .prepare('SELECT id, name, archived_at FROM trees WHERE workspace_id = ? ORDER BY last_active_at DESC')
    .all(workspaceId) as unknown as Array<Pick<TreeRecord, 'id' | 'name' | 'archived_at'>>;

  const allNodes = db
    .prepare(`
      SELECT id, parent_node_id, kind, title, tree_id, deleted_at
      FROM nodes
      WHERE workspace_id = ? AND deleted_at IS NULL AND kind != 'digest'
      ORDER BY created_at ASC
    `)
    .all(workspaceId) as unknown as NodeRecord[];

  const allEdges = db
    .prepare(`
      SELECT source_node_id, target_node_id, kind
      FROM edges
      WHERE workspace_id = ?
        AND kind IN ('branch', 'merge', 'link')
    `)
    .all(workspaceId) as unknown as EdgeRecord[];

  let currentTreeId: string | null = null;
  if (currentNodeId) {
    const cur = allNodes.find((n) => n.id === currentNodeId);
    if (cur) currentTreeId = cur.tree_id;
  }

  const nodeCountByTree = new Map<string, number>();
  for (const n of allNodes) {
    if (!n.tree_id) continue;
    nodeCountByTree.set(n.tree_id, (nodeCountByTree.get(n.tree_id) ?? 0) + 1);
  }

  const incomingEdgesByTarget = new Map<string, EdgeRecord[]>();
  for (const e of allEdges) {
    const arr = incomingEdgesByTarget.get(e.target_node_id);
    if (arr) arr.push(e);
    else incomingEdgesByTarget.set(e.target_node_id, [e]);
  }

  // Build the per-thread representation, fully populated. Truncation below
  // strips the `nodes` arrays from non-current threads as needed.
  //
  // Thread title resolution: trees.name is only written when the user manually
  // renames a tree (rare). For the common case it stays null, so the visible
  // title comes from the root node's title (set by the agent's [TITLE:]
  // sentinel). Without this fallback, every list_threads result reads as
  // "(untitled)" even though the sidebar shows real titles.
  const threads: ThreadJson[] = [];
  let currentThread: ThreadJson | undefined;
  for (const tree of allTrees) {
    const isCurrent = tree.id === currentTreeId;
    const nodeCount = nodeCountByTree.get(tree.id) ?? 0;
    const treeNodes = allNodes.filter((n) => n.tree_id === tree.id);
    const rootNode = treeNodes.find((n) => !n.parent_node_id);
    const resolvedTitle = tree.name ?? rootNode?.title ?? null;
    const t: ThreadJson = {
      id: tree.id,
      title: resolvedTitle,
      node_count: nodeCount,
      nodes: treeNodes.map((n) =>
        buildNodeJson(n, incomingEdgesByTarget.get(n.id) ?? [], currentNodeId),
      ),
    };
    if (tree.archived_at) t.archived = true;
    if (isCurrent) {
      t.current = true;
      currentThread = t;
    }
    threads.push(t);
  }

  const payload: TopologyJson = {
    workspace: wsRow.name,
    threads,
  };
  if (currentTreeId && currentNodeId) {
    payload.current = { thread: currentTreeId, node: currentNodeId };
  }

  const serialize = (p: TopologyJson) => JSON.stringify(p, null, 2);
  let topology = serialize(payload);
  let truncated = false;

  if (topology.length > SIZE_CAP) {
    truncated = true;
    // Drop nodes arrays from non-current threads, oldest (= last in
    // last_active_at DESC ordering) first, until we fit.
    const nonCurrent = threads.filter((t) => t !== currentThread);
    let droppedCount = 0;
    for (let i = nonCurrent.length - 1; i >= 0; i--) {
      if (nonCurrent[i].nodes !== undefined) {
        delete nonCurrent[i].nodes;
        droppedCount++;
        if (droppedCount % 5 === 0 || i === 0) {
          payload.truncated_threads = droppedCount;
          payload.notes = [
            'Some threads were collapsed (nodes omitted) to fit. Call list_threads with workspaceId set to a specific thread id, or search_messages, to drill in.',
          ];
          topology = serialize(payload);
          if (topology.length <= SIZE_CAP) break;
        }
      }
    }
    if (topology.length > SIZE_CAP && currentThread?.nodes) {
      payload.truncated_threads = (payload.truncated_threads ?? 0);
      payload.notes = [
        'Output trimmed: even the current thread is large. Use search_messages to find specific content, then read_node with a node id.',
      ];
      topology = serialize(payload);
    }
  }

  // Hard safety net — slice mid-string if even the trimmed JSON is too big.
  // The result is no longer valid JSON; the trailing note tells the model
  // to recover by calling search_messages instead.
  if (topology.length > HARD_CEILING) {
    truncated = true;
    topology = topology.slice(0, HARD_CEILING) +
      '\n... [output truncated — call search_messages to drill in by keyword]';
  }

  return {
    topology,
    nodeCount: allNodes.length,
    truncated,
  };
}
