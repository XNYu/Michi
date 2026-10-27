import { useSyncExternalStore } from 'react';

/** The Spaces page a new chat starts from: where its progress card shows. */
export interface SpaceConversationScope {
  backendConnectionId: string;
  /** The page itself; null until it has loaded. */
  pageId: string | null;
  /** The page's workspace; null on the Spaces Home, which belongs to none. */
  workspaceId: string | null;
  workspaceName: string | null;
  pageTitle: string;
}

export interface NewChatSheetState {
  /** Which mounted page shows the sheet. */
  scopeId: number;
  workspaceId: string | null;
  text: string;
  /** Changes each time the sheet is (re)opened, so the input takes `text` again. */
  seq: number;
}

/** A start the user asked for that has no progress card on the backend yet. */
export interface PendingStart {
  id: number;
  text: string;
  workspaceId: string;
  workspaceName: string;
  backendConnectionId: string;
  startedFromPageId: string;
  requestedAt: number;
  /** The conversation, once created. Its card shows from then on. */
  nodeId: string | null;
}

interface State {
  scopes: ReadonlyArray<{ id: number; scope: SpaceConversationScope }>;
  sheet: NewChatSheetState | null;
  pending: readonly PendingStart[];
}

const LAST_WORKSPACE_KEY = 'michi:v1:space-new-chat-workspace';

let state: State = { scopes: [], sheet: null, pending: [] };
let nextId = 1;
const listeners = new Set<() => void>();

function set(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function readSpaceConversations(): State {
  return state;
}

export function useSpaceConversationState(): State {
  return useSyncExternalStore(subscribe, readSpaceConversations, readSpaceConversations);
}

/** The page on screen that can show the sheet; the newest mount wins. */
export function currentScope(current: State = state): { id: number; scope: SpaceConversationScope } | null {
  return current.scopes[current.scopes.length - 1] ?? null;
}

export function useCurrentSpaceScope(): SpaceConversationScope | null {
  return currentScope(useSpaceConversationState())?.scope ?? null;
}

/** A page mounts its sheet slot here. Returns the slot id and the way to leave. */
export function registerSpaceScope(scope: SpaceConversationScope): { id: number; update(scope: SpaceConversationScope): void; release(): void } {
  const id = nextId++;
  set({ ...state, scopes: [...state.scopes, { id, scope }] });
  return {
    id,
    update(next) {
      if (!state.scopes.some((entry) => entry.id === id)) return;
      set({ ...state, scopes: state.scopes.map((entry) => (entry.id === id ? { id, scope: next } : entry)) });
    },
    release() {
      set({
        ...state,
        scopes: state.scopes.filter((entry) => entry.id !== id),
        sheet: state.sheet?.scopeId === id ? null : state.sheet,
      });
    },
  };
}

export function lastUsedWorkspaceId(): string | null {
  try { return localStorage.getItem(LAST_WORKSPACE_KEY); } catch { return null; }
}

function rememberWorkspace(workspaceId: string): void {
  try { localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId); } catch { /* optional */ }
}

/**
 * Open the new-chat sheet on the page on screen, optionally prefilled.
 * Without `workspaceId` it starts in the page's workspace, or on the Spaces
 * Home in the last one used. Returns false when no page can show it.
 */
export function openNewChatSheet({ text = '', workspaceId }: { text?: string; workspaceId?: string | null } = {}): boolean {
  const target = currentScope();
  if (!target) return false;
  const seq = (state.sheet?.seq ?? 0) + 1;
  set({ ...state, sheet: { scopeId: target.id, workspaceId: workspaceId ?? target.scope.workspaceId ?? lastUsedWorkspaceId(), text, seq } });
  return true;
}

export function closeNewChatSheet(): void {
  if (state.sheet) set({ ...state, sheet: null });
}

export function setNewChatSheetWorkspace(workspaceId: string): void {
  if (state.sheet) set({ ...state, sheet: { ...state.sheet, workspaceId } });
}

/** Queue the start and close the sheet; the shell-level runner creates the conversation. */
export function requestSpaceConversation(start: Omit<PendingStart, 'id' | 'requestedAt' | 'nodeId'>): number {
  const id = nextId++;
  rememberWorkspace(start.workspaceId);
  set({ ...state, sheet: null, pending: [...state.pending, { ...start, id, requestedAt: Date.now(), nodeId: null }] });
  return id;
}

export function markPendingCreated(id: number, nodeId: string): void {
  set({ ...state, pending: state.pending.map((entry) => (entry.id === id ? { ...entry, nodeId } : entry)) });
}

export function dropPending(id: number): void {
  if (state.pending.some((entry) => entry.id === id)) set({ ...state, pending: state.pending.filter((entry) => entry.id !== id) });
}

export function resetSpaceConversationsForTests(): void {
  state = { scopes: [], sheet: null, pending: [] };
  nextId = 1;
  try { localStorage.removeItem(LAST_WORKSPACE_KEY); } catch { /* optional */ }
  for (const listener of listeners) listener();
}
