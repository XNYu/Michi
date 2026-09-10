import { activeBackendApiBase, workspaceBackendApiBase } from '../../config/backendConnections';

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
  const base = workspaceId ? workspaceBackendApiBase(workspaceId) : activeBackendApiBase();
  const res = await fetch(`${base}/search?${params}`);
  if (!res.ok) throw new Error(`searchMessages failed: ${res.status}`);
  return res.json();
}

// ── Node-grouped search types ──

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

export async function searchNodesGrouped(
  query: string,
  workspaceId?: string,
  limit = 30,
): Promise<{ results: NodeGroupedResult[]; totalNodes: number }> {
  const params = new URLSearchParams({ q: query, mode: 'grouped', limit: String(limit) });
  if (workspaceId) params.set('workspaceId', workspaceId);
  const base = workspaceId ? workspaceBackendApiBase(workspaceId) : activeBackendApiBase();
  const res = await fetch(`${base}/search?${params}`);
  if (!res.ok) throw new Error(`searchNodesGrouped failed: ${res.status}`);
  return res.json();
}
