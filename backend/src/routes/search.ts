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
