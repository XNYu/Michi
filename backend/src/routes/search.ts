import express from 'express';
import { getDb } from '../services/db';

export interface SearchResult {
  id: string;
  node_id: string;
  role: string;
  created_at: number;
  snippet: string;
  node_title: string | null;
  workspace_id: string;
  tree_id: string | null;
  workspace_name: string;
}

interface RawSemanticResult extends SearchResult {
  rank: number;
  content: string;
}

// ── Node-grouped search types ──────────────────────────────────────────────

export interface NodeGroupedSnippet {
  messageId: string;
  role: 'user' | 'assistant';
  snippet: string;
}

export interface NodeGroupedResult {
  nodeId: string;
  nodeTitle: string | null;
  workspaceId: string;
  workspaceName: string;
  treeId: string | null;
  lastMessageAt: number;
  totalMatches: number;
  breadcrumb: string[];
  snippets: NodeGroupedSnippet[];
}

export function setupSearchRoutes(): express.Router {
  const router = express.Router();

  router.get('/search', (req, res) => {
    const { q, workspaceId, mode = 'keyword', limit = '20' } = req.query;
    if (!q || typeof q !== 'string' || q.trim().length === 0) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const limitNum = Math.min(parseInt(limit as string, 10) || 20, 100);
    // In cloud mode, scope all FTS results to the authenticated user only.
    // There is no cross-user FTS path.
    const userId: string | undefined = process.env.MICHI_CLOUD === '1'
      ? (req.user?.id as string | undefined)
      : undefined;

    try {
      if (mode === 'grouped') {
        const results = nodeGroupedSearch(q.trim(), workspaceId as string | undefined, limitNum, userId);
        return res.json({ results, totalNodes: results.length });
      }
      if (mode === 'semantic') {
        const results = semanticSearch(q.trim(), workspaceId as string | undefined, limitNum, userId);
        return res.json({ results, total: results.length });
      }
      // Default: keyword search — userId scopes results to caller's workspaces in cloud mode.
      const results = keywordSearch(q.trim(), workspaceId as string | undefined, limitNum, userId);
      res.json({ results, total: results.length });
    } catch {
      res.status(400).json({ error: 'Invalid search query' });
    }
  });

  return router;
}

function sanitizeFtsQuery(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

export function keywordSearch(query: string, workspaceId?: string, limit = 20, userId?: string): SearchResult[] {
  const db = getDb();
  const ftsQuery = sanitizeFtsQuery(query);
  let sql = `
    SELECT m.id, m.node_id, m.role, m.created_at,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 48) as snippet,
           n.title as node_title, n.workspace_id, n.tree_id,
           w.name as workspace_name
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.rowid
    JOIN nodes n ON m.node_id = n.id
    JOIN workspaces w ON n.workspace_id = w.id
    WHERE messages_fts MATCH ?
  `;
  const params: (string | number)[] = [ftsQuery];
  if (workspaceId) {
    sql += ' AND n.workspace_id = ?';
    params.push(workspaceId);
  }
  // In cloud mode, always scope FTS to the authenticated user's workspaces only.
  // There is no cross-user FTS path.
  if (process.env.MICHI_CLOUD === '1' && userId) {
    sql += ' AND w.owner_user_id = ?';
    params.push(userId);
  }
  sql += ' AND n.deleted_at IS NULL AND n.kind != \'digest\' ORDER BY rank LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params) as unknown as SearchResult[];
}

// ── Node-grouped search ────────────────────────────────────────────────────
// Returns one entry per matching node (deduped), time-sorted, with up to 3
// best snippets and a root-first breadcrumb trail.

interface RawGroupedRow {
  node_id: string;
  node_title: string | null;
  workspace_id: string;
  workspace_name: string;
  tree_id: string | null;
  last_message_at: number;
  total_matches: number;
  message_id: string;
  role: string;
  snippet: string;
}

export function nodeGroupedSearch(
  query: string,
  workspaceId?: string,
  limit = 20,
  userId?: string,
): NodeGroupedResult[] {
  const db = getDb();
  const ftsQuery = sanitizeFtsQuery(query);

  // Two-layer CTE:
  //   1. node_matches — one row per matching node, sorted by most-recent message
  //   2. ranked_snippets — up to 3 best snippets (by FTS rank) per node
  let sql = `
    WITH node_matches AS (
      SELECT m.node_id,
             MAX(m.created_at) AS last_message_at,
             COUNT(*) AS total_matches
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      JOIN nodes n ON m.node_id = n.id
      JOIN workspaces w ON n.workspace_id = w.id
      WHERE messages_fts MATCH ?
        AND n.deleted_at IS NULL AND n.kind != 'digest'
  `;
  const params: (string | number)[] = [ftsQuery];
  if (workspaceId) {
    sql += ' AND n.workspace_id = ?';
    params.push(workspaceId);
  }
  if (process.env.MICHI_CLOUD === '1' && userId) {
    sql += ' AND w.owner_user_id = ?';
    params.push(userId);
  }
  sql += `
      GROUP BY m.node_id
      ORDER BY last_message_at DESC
      LIMIT ?
    ),
    ranked_msgs AS (
      SELECT m.id AS message_id, m.node_id, m.role, messages_fts.rowid AS fts_rowid,
             ROW_NUMBER() OVER (PARTITION BY m.node_id ORDER BY rank) AS rn
      FROM messages_fts
      JOIN messages m ON messages_fts.rowid = m.rowid
      WHERE m.node_id IN (SELECT node_id FROM node_matches)
        AND messages_fts MATCH ?
    )
    SELECT rm.node_id, rm.message_id, rm.role,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 48) AS snippet,
           nm.last_message_at, nm.total_matches,
           n.title AS node_title, n.workspace_id, n.tree_id,
           w.name AS workspace_name
    FROM ranked_msgs rm
    JOIN messages_fts ON messages_fts.rowid = rm.fts_rowid AND messages_fts MATCH ?
    JOIN node_matches nm ON rm.node_id = nm.node_id
    JOIN nodes n ON rm.node_id = n.id
    JOIN workspaces w ON n.workspace_id = w.id
    WHERE rm.rn <= 3
    ORDER BY nm.last_message_at DESC, rm.node_id, rm.rn
  `;
  params.push(limit);
  params.push(ftsQuery);
  params.push(ftsQuery); // outer SELECT MATCH for snippet() highlighting

  const rows = db.prepare(sql).all(...params) as unknown as RawGroupedRow[];

  // Group flat rows into NodeGroupedResult entries.
  const nodeMap = new Map<string, NodeGroupedResult>();
  const nodeOrder: string[] = [];
  for (const row of rows) {
    let entry = nodeMap.get(row.node_id);
    if (!entry) {
      entry = {
        nodeId: row.node_id,
        nodeTitle: row.node_title,
        workspaceId: row.workspace_id,
        workspaceName: row.workspace_name,
        treeId: row.tree_id,
        lastMessageAt: row.last_message_at,
        totalMatches: row.total_matches,
        breadcrumb: [],
        snippets: [],
      };
      nodeMap.set(row.node_id, entry);
      nodeOrder.push(row.node_id);
    }
    entry.snippets.push({
      messageId: row.message_id,
      role: row.role === 'assistant' ? 'assistant' : 'user',
      snippet: row.snippet,
    });
  }

  // ── Title-match pass ─────────────────────────────────────────────────────
  // Find nodes whose title contains the query tokens but whose messages
  // did NOT match the FTS query above.  This catches the common case where
  // a user searches for words that appear only in the thread title.
  if (nodeMap.size < limit) {
    const titleResults = searchNodesByTitle(db, query, workspaceId, userId, limit - nodeMap.size, nodeMap);
    for (const entry of titleResults) {
      if (!nodeMap.has(entry.nodeId)) {
        nodeMap.set(entry.nodeId, entry);
        nodeOrder.push(entry.nodeId);
      }
    }
  }

  // Build breadcrumbs by walking parent_node_id up to root for each node.
  const results = nodeOrder.map((id) => nodeMap.get(id)!);
  if (results.length > 0) {
    buildBreadcrumbs(db, results);
  }
  return results;
}

/**
 * Walk parent_node_id chains to build root-first breadcrumb arrays.
 * Fetches all ancestors in one query per workspace (batched), then walks
 * in JS to avoid per-node recursive CTEs.
 */
function buildBreadcrumbs(db: ReturnType<typeof getDb>, results: NodeGroupedResult[]): void {
  // Collect all unique node IDs we need ancestors for.
  const nodeIds = new Set(results.map((r) => r.nodeId));

  // Collect all workspace IDs involved.
  const workspaceIds = new Set(results.map((r) => r.workspaceId));

  // Fetch all non-deleted, non-digest nodes from involved workspaces.
  // For small result sets this is efficient; for very large workspaces,
  // a recursive CTE per node would be better, but typically breadcrumb
  // depth is < 10 and workspace node count < 10k.
  const allNodes = new Map<string, { id: string; parentNodeId: string | null; title: string | null }>();
  for (const wsId of workspaceIds) {
    const rows = db.prepare(
      `SELECT id, parent_node_id, title FROM nodes
       WHERE workspace_id = ? AND deleted_at IS NULL AND kind != 'digest'`
    ).all(wsId) as unknown as Array<{ id: string; parent_node_id: string | null; title: string | null }>;
    for (const r of rows) {
      allNodes.set(r.id, { id: r.id, parentNodeId: r.parent_node_id, title: r.title });
    }
  }

  // Walk each result node to root, collecting titles.
  for (const result of results) {
    const trail: string[] = [];
    let current = allNodes.get(result.nodeId);
    // Safety: limit to 50 levels to avoid infinite loops on corrupt data.
    let depth = 0;
    while (current && depth < 50) {
      trail.push(current.title ?? 'Untitled');
      if (!current.parentNodeId) break;
      current = allNodes.get(current.parentNodeId);
      depth++;
    }
    // trail is leaf-first; reverse to get root-first breadcrumb.
    trail.reverse();
    result.breadcrumb = trail;
  }
}

/**
 * Find nodes whose title matches the query via the nodes_fts FTS5 index,
 * excluding nodes already found by FTS message search.
 *
 * Returns NodeGroupedResult entries with a highlighted title snippet.
 * Falls back to LIKE-based search if nodes_fts doesn't exist yet
 * (migration 0020 hasn't been applied).
 */
function searchNodesByTitle(
  db: ReturnType<typeof getDb>,
  rawQuery: string,
  workspaceId: string | undefined,
  userId: string | undefined,
  limit: number,
  existingNodes: Map<string, NodeGroupedResult>,
): NodeGroupedResult[] {
  if (limit <= 0) return [];

  const ftsQuery = sanitizeFtsQuery(rawQuery);
  if (!ftsQuery) return [];

  // Check if nodes_fts table exists (migration 0020).
  const hasFts = (() => {
    try {
      const row = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='nodes_fts'"
      ).get() as { name: string } | undefined;
      return !!row;
    } catch { return false; }
  })();

  if (hasFts) {
    return searchNodesByTitleFts(db, ftsQuery, workspaceId, userId, limit, existingNodes);
  }
  return searchNodesByTitleLike(db, rawQuery, workspaceId, userId, limit, existingNodes);
}

/** FTS5-based title search (preferred — used when nodes_fts exists). */
function searchNodesByTitleFts(
  db: ReturnType<typeof getDb>,
  ftsQuery: string,
  workspaceId: string | undefined,
  userId: string | undefined,
  limit: number,
  existingNodes: Map<string, NodeGroupedResult>,
): NodeGroupedResult[] {
  // Exclude node IDs already covered by message FTS.
  const excludeIds = [...existingNodes.keys()];
  const excludePlaceholders = excludeIds.map(() => '?').join(',');

  let sql = `
    SELECT n.id AS node_id, n.title AS node_title,
           n.workspace_id, n.tree_id, w.name AS workspace_name,
           snippet(nodes_fts, 0, '<mark>', '</mark>', '…', 64) AS title_snippet,
           COALESCE(
             (SELECT MAX(m.created_at) FROM messages m WHERE m.node_id = n.id),
             n.created_at
           ) AS last_message_at
    FROM nodes_fts
    JOIN nodes n ON nodes_fts.rowid = n.rowid
    JOIN workspaces w ON n.workspace_id = w.id
    WHERE nodes_fts MATCH ?
      AND n.deleted_at IS NULL AND n.kind != 'digest'
      AND n.title IS NOT NULL AND TRIM(n.title) != ''
  `;
  const params: (string | number)[] = [ftsQuery];

  if (excludeIds.length > 0) {
    sql += ` AND n.id NOT IN (${excludePlaceholders})`;
    params.push(...excludeIds);
  }
  if (workspaceId) {
    sql += ' AND n.workspace_id = ?';
    params.push(workspaceId);
  }
  if (process.env.MICHI_CLOUD === '1' && userId) {
    sql += ' AND w.owner_user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY last_message_at DESC LIMIT ?';
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as unknown as Array<{
      node_id: string;
      node_title: string;
      workspace_id: string;
      tree_id: string | null;
      workspace_name: string;
      title_snippet: string;
      last_message_at: number;
    }>;

    return rows.map((row) => ({
      nodeId: row.node_id,
      nodeTitle: row.node_title,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      treeId: row.tree_id,
      lastMessageAt: row.last_message_at,
      totalMatches: 0,
      breadcrumb: [],
      snippets: [{
        messageId: '',
        role: 'assistant' as const,
        snippet: row.title_snippet,
      }],
    }));
  } catch {
    // If FTS query fails (e.g. corrupt index), fall back silently.
    return [];
  }
}

/** LIKE-based title search (fallback when nodes_fts doesn't exist). */
function searchNodesByTitleLike(
  db: ReturnType<typeof getDb>,
  rawQuery: string,
  workspaceId: string | undefined,
  userId: string | undefined,
  limit: number,
  existingNodes: Map<string, NodeGroupedResult>,
): NodeGroupedResult[] {
  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || limit <= 0) return [];

  // Build LIKE clauses — every token must appear in the title.
  const likeClauses = tokens.map(() => 'n.title LIKE ?');
  const likeParams = tokens.map((t) => `%${t}%`);

  // Exclude node IDs already covered by FTS results.
  const excludeIds = [...existingNodes.keys()];
  const excludePlaceholders = excludeIds.map(() => '?').join(',');

  let sql = `
    SELECT n.id AS node_id, n.title AS node_title,
           n.workspace_id, n.tree_id, w.name AS workspace_name,
           COALESCE(
             (SELECT MAX(m.created_at) FROM messages m WHERE m.node_id = n.id),
             n.created_at
           ) AS last_message_at
    FROM nodes n
    JOIN workspaces w ON n.workspace_id = w.id
    WHERE n.deleted_at IS NULL AND n.kind != 'digest'
      AND n.title IS NOT NULL AND TRIM(n.title) != ''
      AND ${likeClauses.join(' AND ')}
  `;
  const params: (string | number)[] = [...likeParams];

  if (excludeIds.length > 0) {
    sql += ` AND n.id NOT IN (${excludePlaceholders})`;
    params.push(...excludeIds);
  }
  if (workspaceId) {
    sql += ' AND n.workspace_id = ?';
    params.push(workspaceId);
  }
  if (process.env.MICHI_CLOUD === '1' && userId) {
    sql += ' AND w.owner_user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY last_message_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as unknown as Array<{
    node_id: string;
    node_title: string;
    workspace_id: string;
    tree_id: string | null;
    workspace_name: string;
    last_message_at: number;
  }>;

  // Build highlight-marked title snippet for each match.
  return rows.map((row) => {
    // Highlight matching tokens in the title with <mark> tags.
    let markedTitle = escapeHtml(row.node_title);
    for (const token of tokens) {
      const escaped = escapeRegex(token);
      markedTitle = markedTitle.replace(
        new RegExp(`(${escaped})`, 'gi'),
        '<mark>$1</mark>',
      );
    }

    return {
      nodeId: row.node_id,
      nodeTitle: row.node_title,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      treeId: row.tree_id,
      lastMessageAt: row.last_message_at,
      totalMatches: 0, // title-only match, no message matches
      breadcrumb: [],
      snippets: [{
        messageId: '',  // synthetic — no real message
        role: 'assistant' as const,
        snippet: markedTitle,
      }],
    };
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function semanticSearch(query: string, workspaceId?: string, limit = 20, userId?: string): SearchResult[] {
  const db = getDb();
  const tokens = query.split(/\s+/).filter(t => t.length > 1);
  if (tokens.length === 0) return keywordSearch(query, workspaceId, limit, userId);

  const ftsQuery = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  const candidateLimit = limit * 3;

  let sql = `
    SELECT m.id, m.node_id, m.role, m.created_at, m.content,
           snippet(messages_fts, 0, '<mark>', '</mark>', '…', 48) as snippet,
           n.title as node_title, n.workspace_id, n.tree_id,
           w.name as workspace_name, rank
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.rowid
    JOIN nodes n ON m.node_id = n.id
    JOIN workspaces w ON n.workspace_id = w.id
    WHERE messages_fts MATCH ?
  `;
  const params: (string | number)[] = [ftsQuery];
  if (workspaceId) {
    sql += ' AND n.workspace_id = ?';
    params.push(workspaceId);
  }
  // In cloud mode, always scope FTS to the authenticated user's workspaces only.
  // There is no cross-user FTS path.
  if (process.env.MICHI_CLOUD === '1' && userId) {
    sql += ' AND w.owner_user_id = ?';
    params.push(userId);
  }
  sql += ' AND n.deleted_at IS NULL AND n.kind != \'digest\' ORDER BY rank LIMIT ?';
  params.push(candidateLimit);

  const candidates = db.prepare(sql).all(...params) as unknown as RawSemanticResult[];
  const queryLower = query.toLowerCase();

  const scored = candidates.map(c => {
    let score = -c.rank; // FTS5 rank is negative; negate for positive score
    if (c.node_title?.toLowerCase().includes(queryLower)) score += 10;
    if (c.content.toLowerCase().includes(queryLower)) score += 5;
    const ageMs = Date.now() - c.created_at;
    if (ageMs < 7 * 86400000) score += 3;
    else if (ageMs < 30 * 86400000) score += 1;
    return { ...c, finalScore: score };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);

  // Strip internal fields before returning
  return scored.slice(0, limit).map(({ content, rank, finalScore, ...rest }) => rest);
}
