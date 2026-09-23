import { fetchTreeMessages } from '../services/api';
import type { ChatNodeState, Project } from './chatTypes';
import { findTreeIdForNode } from './tree';

export const TREE_PREFETCH_LIMIT = 4;
export const TREE_PREFETCH_CONCURRENCY = 2;
export const TREE_PREFETCH_TTL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface TreeRequest {
  promise: Promise<unknown[]>;
  nodes: Map<string, ChatNodeState>;
  controller: AbortController;
  expiresAt: number;
  pending: boolean;
  foreground: boolean;
  timeout?: ReturnType<typeof setTimeout>;
}

// Activating a tree stamps viewedAt before its pending read resolves. That
// presentation-only change must not invalidate an otherwise identical snapshot.
export function sameTreeMessageNode(before: ChatNodeState | undefined, after: ChatNodeState | undefined): boolean {
  if (!before || !after) return false;
  return (Object.keys({ ...before, ...after }) as Array<keyof ChatNodeState>)
    .every((key) => key === 'viewedAt' || before[key] === after[key]);
}

function unloadedNodes(project: Project, treeId: string, nodes: Record<string, ChatNodeState>) {
  return new Map(project.chatIds.flatMap((id) => {
    const node = nodes[id];
    return node && node.messagesLoaded === false && !node.deletedAt
      && !(node.status === 'streaming' && node.messages.length > 0)
      && findTreeIdForNode(id, project) === treeId ? [[id, node] as const] : [];
  }));
}

/** Short-lived speculative reads, scoped to one ChatProvider/user, never UI state. */
export class TreeMessageRequests {
  private entries = new Map<string, TreeRequest>();

  private drop(key: string, entry: TreeRequest) {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    clearTimeout(entry.timeout);
    entry.controller.abort();
  }

  private request(project: Project, treeId: string, nodes: Record<string, ChatNodeState>, foreground: boolean) {
    if (project.deletedAt || !project.trees.some((tree) => tree.id === treeId)) return null;
    const snapshot = unloadedNodes(project, treeId, nodes);
    if (snapshot.size === 0) return null;
    // Live checkpoints must be read on activation, not speculatively cached.
    if (!foreground && [...snapshot.values()].some((node) => node.status === 'streaming')) return null;
    const key = JSON.stringify([project.backendConnectionId ?? 'local', project.id, treeId]);
    for (const [id, entry] of this.entries) {
      if (!entry.foreground && entry.expiresAt <= Date.now()) this.drop(id, entry);
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.nodes.size === snapshot.size
        && [...snapshot].every(([id, node]) => sameTreeMessageNode(existing.nodes.get(id), node))) {
        existing.foreground ||= foreground;
        if (foreground) clearTimeout(existing.timeout);
        return { key, entry: existing };
      }
      // An intent event must never cancel a foreground read.
      if (existing.foreground && !foreground) return null;
      this.drop(key, existing);
    }
    const speculative = [...this.entries].filter(([, entry]) => !entry.foreground);
    if (!foreground && speculative.filter(([, entry]) => entry.pending).length >= TREE_PREFETCH_CONCURRENCY) return null;
    if (speculative.length >= TREE_PREFETCH_LIMIT) {
      const oldest = speculative.find(([, entry]) => !entry.pending) ?? speculative[0];
      this.drop(...oldest);
    }

    const controller = new AbortController();
    const entry: TreeRequest = {
      controller, nodes: snapshot, expiresAt: Date.now() + TREE_PREFETCH_TTL_MS,
      pending: true, foreground, promise: Promise.resolve([]),
    };
    if (!foreground) entry.timeout = setTimeout(() => this.drop(key, entry), REQUEST_TIMEOUT_MS);
    this.entries.set(key, entry);
    entry.promise = (async () => {
      try {
        const rows = await fetchTreeMessages(project.id, treeId, project.backendConnectionId, controller.signal);
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        return rows;
      } catch (error) {
        this.drop(key, entry);
        throw error;
      } finally {
        entry.pending = false;
        clearTimeout(entry.timeout);
      }
    })();
    // A hover-only request has no awaiting component to handle its rejection.
    void entry.promise.catch(() => {});
    return { key, entry };
  }

  prefetch(project: Project, treeId: string, nodes: Record<string, ChatNodeState>): void {
    this.request(project, treeId, nodes, false);
  }

  acquire(project: Project, treeId: string, nodes: Record<string, ChatNodeState>, signal: AbortSignal) {
    if (signal.aborted) return null;
    const request = this.request(project, treeId, nodes, true);
    if (!request) return null;
    const { key, entry } = request;
    signal.addEventListener('abort', () => this.drop(key, entry), { once: true });
    return entry;
  }

  clear(): void {
    for (const [key, entry] of this.entries) this.drop(key, entry);
  }
}
