import { API_BASE_URL } from '../../config/env';

// ── Search API ──

export interface SearchResult {
  id: string;
  node_id: string;
  node_title: string | null;
  workspace_id: string;
  workspace_name: string;
  tree_id: string;
  role: string;
  snippet: string;
  created_at: number;
}

export async function searchMessages(
  query: string,
  workspaceId?: string,
  mode: 'keyword' | 'semantic' = 'keyword',
  limit = 20,
): Promise<{ results: SearchResult[]; total: number }> {
  const params = new URLSearchParams({ q: query, mode, limit: String(limit) });
  if (workspaceId) params.set('workspaceId', workspaceId);
  const res = await fetch(`${API_BASE_URL}/search?${params}`);
  if (!res.ok) throw new Error(`searchMessages failed: ${res.status}`);
  return res.json();
}
