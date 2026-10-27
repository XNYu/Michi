import { useCallback, useSyncExternalStore } from 'react';
import type { MichiContextItem } from 'michi-shared';
import {
  assistantPageKey,
  formatAssistantContext,
  mergeAttachments,
  type AssistantPageView,
} from './assistantContext';

/**
 * What rides along with the assistant's next send, per node: the items the
 * user handed over (chips above the composer) and the page they were on.
 * In memory only — chips are a moment's material, not a draft to restore.
 *
 * TPane folds `pendingAssistantContext(nodeId)` into the send's quote and then
 * calls `noteAssistantContextSent(nodeId)`, the same way it carries a Michi
 * handoff; so the floating panel and the expanded pane behave alike.
 */
export interface AssistantComposerState {
  attachments: MichiContextItem[];
  page: AssistantPageView | null;
  /** The page the last send already told the assistant about. */
  sentPageKey: string | null;
  /**
   * Prompts a caller asked to send (`openMichiAssistant({ send: true })`).
   * The node's TPane sends them through its own send path (runtime binding,
   * context quote, queue while streaming), leaving the user's draft alone.
   */
  sends: PendingAssistantSend[];
  /**
   * A prompt a caller put in the composer (`openMichiAssistant({ prompt })`,
   * e.g. "This isn't right" on a workspace document) and the page it was
   * for. Once that page is gone, or the panel is dismissed, the prompt is
   * cleared if the user left it as it was; never once they edited it.
   */
  injected: InjectedAssistantDraft | null;
}

export interface InjectedAssistantDraft {
  value: string;
  pageKey: string | null;
}

export interface PendingAssistantSend {
  id: string;
  prompt: string;
}

const NO_SENDS: PendingAssistantSend[] = [];
const EMPTY: AssistantComposerState = { attachments: [], page: null, sentPageKey: null, sends: NO_SENDS, injected: null };

let states: Record<string, AssistantComposerState> = {};
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function update(nodeId: string, change: (state: AssistantComposerState) => AssistantComposerState): void {
  const current = states[nodeId] ?? EMPTY;
  const next = change(current);
  if (next === current) return;
  states = { ...states, [nodeId]: next };
  emit();
}

export function getAssistantComposer(nodeId: string): AssistantComposerState {
  return states[nodeId] ?? EMPTY;
}

export function subscribeAssistantComposer(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAssistantComposer(nodeId: string | null): AssistantComposerState {
  const getSnapshot = useCallback(() => (nodeId ? getAssistantComposer(nodeId) : EMPTY), [nodeId]);
  return useSyncExternalStore(subscribeAssistantComposer, getSnapshot, getSnapshot);
}

function samePage(a: AssistantPageView | null, b: AssistantPageView | null): boolean {
  return assistantPageKey(a) === assistantPageKey(b) && (a?.title ?? '') === (b?.title ?? '');
}

export function setAssistantPage(nodeId: string, page: AssistantPageView | null): void {
  update(nodeId, (state) => (samePage(state.page, page) ? state : { ...state, page }));
}

export function addAssistantAttachments(nodeId: string, items: readonly MichiContextItem[]): void {
  if (items.length === 0) return;
  update(nodeId, (state) => {
    const attachments = mergeAttachments(state.attachments, items);
    return attachments.length === state.attachments.length ? state : { ...state, attachments };
  });
}

export function removeAssistantAttachment(nodeId: string, item: Pick<MichiContextItem, 'kind' | 'id'>): void {
  update(nodeId, (state) => {
    const attachments = state.attachments.filter((a) => a.kind !== item.kind || a.id !== item.id);
    return attachments.length === state.attachments.length ? state : { ...state, attachments };
  });
}

/**
 * The quote the next send carries, or null. The page line goes along with
 * attachments, or when the user moved to a page the assistant hasn't heard
 * about — not on every follow-up.
 */
export function pendingAssistantContext(nodeId: string): string | null {
  const state = states[nodeId];
  if (!state) return null;
  const pageKey = assistantPageKey(state.page);
  const page = state.attachments.length > 0 || (pageKey && pageKey !== state.sentPageKey) ? state.page : null;
  return formatAssistantContext(page, state.attachments);
}

/** The pending context went out with a send: chips clear, the page counts as told. */
export function noteAssistantContextSent(nodeId: string): void {
  update(nodeId, (state) => {
    const sentPageKey = assistantPageKey(state.page) ?? state.sentPageKey;
    if (state.attachments.length === 0 && sentPageKey === state.sentPageKey) return state;
    return { ...state, attachments: [], sentPageKey };
  });
}

let sendSeq = 0;

/** Ask the node's pane to send `prompt` (with the pending context) as soon as it can. */
export function requestAssistantSend(nodeId: string, prompt: string): void {
  const text = prompt.trim();
  if (!text) return;
  sendSeq += 1;
  update(nodeId, (state) => ({ ...state, sends: [...state.sends, { id: `s${sendSeq}`, prompt: text }] }));
}

/** The requested sends, removed from the store: each one goes out once. */
export function takeAssistantSends(nodeId: string): PendingAssistantSend[] {
  const sends = states[nodeId]?.sends ?? NO_SENDS;
  if (sends.length > 0) update(nodeId, (state) => ({ ...state, sends: NO_SENDS }));
  return sends;
}

/** The node's requested sends (a stable empty array when none). */
export function useAssistantPendingSends(nodeId: string): PendingAssistantSend[] {
  const getSnapshot = useCallback(() => states[nodeId]?.sends ?? NO_SENDS, [nodeId]);
  return useSyncExternalStore(subscribeAssistantComposer, getSnapshot, getSnapshot);
}

/** A caller's prompt went into the composer, for the page the composer is on now. */
export function noteAssistantDraftInjected(nodeId: string, value: string): void {
  update(nodeId, (state) => ({ ...state, injected: { value, pageKey: assistantPageKey(state.page) } }));
}

/** The injected prompt's page is no longer the one on screen. */
export function injectedAssistantDraftIsStale(nodeId: string): boolean {
  const state = states[nodeId];
  return !!state?.injected && state.injected.pageKey !== assistantPageKey(state.page);
}

/** The injected prompt, forgotten: each one is judged once. */
export function takeInjectedAssistantDraft(nodeId: string): InjectedAssistantDraft | null {
  const injected = states[nodeId]?.injected ?? null;
  if (injected) update(nodeId, (state) => ({ ...state, injected: null }));
  return injected;
}

/** The composer still holds exactly the injected prompt: nothing the user typed, picked or quoted. */
export function isUntouchedInjectedDraft(
  injected: InjectedAssistantDraft,
  draft: { value: string; mentions?: readonly unknown[]; quotedText?: string | null } | null | undefined,
): boolean {
  return !!draft
    && typeof draft.value === 'string'
    && draft.value.trim() === injected.value.trim()
    && (draft.mentions?.length ?? 0) === 0
    && !draft.quotedText;
}

/** Test seam. */
export function resetAssistantComposerForTests(): void {
  states = {};
  emit();
}
