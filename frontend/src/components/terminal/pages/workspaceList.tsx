import React from 'react';
import type { BackendConnectionSummary } from '../../../config/backendConnections';
import { workspaceMachineLabel } from '../../WorkspaceLocation';
import { Button } from '../../ui/controls';

// What the Workspaces page knows about each workspace, and the helpers both of
// its layouts (the desktop table and the phone list) read it through.

export interface ThreadPreview { title: string; age: string; branches: number; activeAt: number }
export interface NodeMeta { title: string; lastActiveAt: number; kind: 'chat' | 'digest' }
export interface WorkspaceCardData {
  id: string;
  name: string;
  cwd?: string;
  backendConnectionId?: string;
  active: boolean;
  /** When it was pinned; pinned workspaces list newest pin first, as in the sidebar. */
  pinnedAt: number | null;
  liveCount: number;
  branches: number;
  threadCount: number;
  streaming: number;
  digests: number;
  lastTs: number;
  /** The workspace's newest conversation ended in an error. */
  failed: { title: string; outcomeUnknown: boolean } | null;
  threads: ThreadPreview[];
  /** All live nodes with a derivable title — used for filter scope and for the
   * search-result preview that replaces the latest thread while a query is
   * active. */
  nodes: NodeMeta[];
  models: string[];
}

export function formatRelative(ts: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

/** formatRelative as a time in the past: "5m ago", but never "just now ago". */
export function formatAgo(ts: number): string {
  const age = formatRelative(ts);
  return age === 'just now' || age === '—' ? age : `${age} ago`;
}

/** `/Users/<name>/…`, `/home/<name>/…` and `/local/home/<name>/…` (a dev
 *  desktop's real home, behind its `/home` link) read as `~/…`: the home
 *  prefix is the same on every row and only costs width. `/Users/Shared` is
 *  not anyone's home, so it stays as written. */
export function displayPath(cwd: string): string {
  return cwd.replace(/^(?:\/Users|\/home|\/local\/home)\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/, '~');
}

/** The path as the row should show it for a given filter: shortened, unless the
 *  query only hits inside the part shortening would hide — then the full path,
 *  so the highlight has something to land on. */
export function pathForQuery(cwd: string, query: string): string {
  const short = displayPath(cwd);
  if (!query) return short;
  const q = query.toLowerCase();
  if (short.toLowerCase().includes(q)) return short;
  return cwd.toLowerCase().includes(q) ? cwd : short;
}

/** Whether a workspace answers the filter: by name, machine, host, path or a
 *  conversation title. */
export function matchesWorkspaceQuery(card: WorkspaceCardData, query: string, connections: BackendConnectionSummary[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return card.name.toLowerCase().includes(q)
    || workspaceMachineLabel(card.backendConnectionId, connections, ' - ').toLowerCase().includes(q)
    || (connections.find(connection => connection.id === card.backendConnectionId)?.sshHost?.toLowerCase().includes(q) ?? false)
    || (card.cwd?.toLowerCase().includes(q) ?? false)
    // …and the path as the row displays it, so typing `~/code` finds it.
    || (card.cwd ? displayPath(card.cwd).toLowerCase().includes(q) : false)
    || card.threads.some((t) => t.title.toLowerCase().includes(q))
    || card.nodes.some((n) => n.title.toLowerCase().includes(q));
}

/** The conversations whose titles the query hits, newest first. */
export function matchingNodes(nodes: NodeMeta[], query: string): NodeMeta[] {
  if (!query) return [];
  const q = query.toLowerCase();
  return nodes
    .filter((n) => n.title.toLowerCase().includes(q))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const needle = q.toLowerCase();
  const haystack = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const hit = haystack.indexOf(needle, cursor);
    if (hit < 0) { parts.push(text.slice(cursor)); break; }
    if (hit > cursor) parts.push(text.slice(cursor, hit));
    parts.push(
      <mark
        key={key++}
        style={{
          background: 'color-mix(in srgb, var(--term-accent) 28%, transparent)',
          color: 'inherit',
          padding: '0 1px',
          borderRadius: 'var(--ui-radius-sm)',
        }}
      >
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    cursor = hit + q.length;
  }
  return <>{parts}</>;
}

export function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div
      style={{
        margin: '40px auto',
        maxWidth: 520,
        padding: '40px 32px',
        border: '1px solid var(--term-line)',
        background: 'var(--term-surface)',
        textAlign: 'center',
        boxShadow: '0 1px 2px rgba(26,25,22,.04), 0 6px 18px rgba(26,25,22,.05)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-3xl)',
          lineHeight: 1.3,
          fontWeight: 600,
          color: 'var(--term-fg)',
          marginBottom: 8,
        }}
      >
        Nothing here yet.
      </div>
      <p
        style={{
          margin: '0 0 20px',
          fontSize: 'var(--fs-lg)',
          color: 'var(--term-muted)',
          lineHeight: 1.6,
        }}
      >
        Workspaces hold all the threads, branches, and digests for one corner of your
        thinking. Make one for a project, a question, or whatever you keep coming back to.
      </p>
      <Button variant="primary" onClick={onNew} style={{ padding: '10px 18px' }}>
        + new workspace
      </Button>
    </div>
  );
}
