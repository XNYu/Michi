import { useMemo, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { backendEntityId } from '../../config/backendIdentity';
import { describePageReference, fetchSourcePreview } from './sourceApi';

/** Where in Spaces a jump to a conversation started, and so where "Back" returns. */
export type SourceOrigin =
  | { kind: 'page'; backendConnectionId: string; workspaceId: string; pageId: string; title: string }
  | { kind: 'home'; title: string }
  | { kind: 'workspace'; backendConnectionId: string; workspaceId: string; title: string }
  | { kind: 'all-tasks'; title: string };

/** A page the cited message is a source of: its title names it in the "Referenced by" mark. */
export interface SourcePage { backendConnectionId: string; workspaceId: string; pageId: string; title: string }

/** One message of a conversation, as page change records and Home items name it. */
export interface SourceTarget {
  backendConnectionId: string;
  /** The conversation's workspace, when the caller knows it; the backend answers it otherwise. */
  workspaceId?: string | null;
  nodeId?: string | null;
  messageId?: string | null;
}

export interface SourcePopoverState {
  target: SourceTarget;
  anchor: HTMLElement | null;
  page: SourcePage | null;
  origin: SourceOrigin | null;
  scroll: SourceScroll | null;
}

export interface SourceScroll { selector: string; top: number }

export interface SourceBack { origin: SourceOrigin; scroll: SourceScroll | null }

export interface SourceReference {
  nodeId: string;
  messageId: string;
  /** "<page> · <blocks>" for a page's source; null when the jump came from a Home row. */
  label: string | null;
  /** Bumped on every jump so the conversation scrolls and focuses again. */
  token: number;
  focus: 'composer' | 'message';
}

/** A conversation opened without a message (a new conversation's card): only its composer may take focus. */
export interface SourceFocusRequest { nodeId: string; token: number }

/** What the shell does for the store: it alone knows what Spaces shows and how to get there. */
export interface SourceNavigator {
  currentOrigin(): SourceOrigin | null;
  reveal(workspaceId: string, nodeId: string): Promise<boolean>;
  returnTo(origin: SourceOrigin): void;
}

interface State {
  popover: SourcePopoverState | null;
  back: SourceBack | null;
  reference: SourceReference | null;
  focus: SourceFocusRequest | null;
}

let state: State = { popover: null, back: null, reference: null, focus: null };
let navigator: SourceNavigator | null = null;
let token = 0;
const claimed = new Set<number>();
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const listener of [...listeners]) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const snapshot = () => state;

export function useSourceNav(): State { return useSyncExternalStore(subscribe, snapshot, snapshot); }
export function getSourceNavState(): State { return state; }

const referenceFor = (nodeId: string) => () => (state.reference?.nodeId === nodeId ? state.reference : null);
const focusFor = (nodeId: string) => () => (state.focus?.nodeId === nodeId ? state.focus : null);

/** The highlighted message of this conversation, while the back bar names its page. */
export function useSourceReference(nodeId: string): SourceReference | null {
  const get = useMemo(() => referenceFor(nodeId), [nodeId]);
  return useSyncExternalStore(subscribe, get, get);
}

/** The jump into this conversation still to be carried out: where to scroll, and what gets focus. */
export function useSourceJump(nodeId: string): { token: number; messageId: string | null; focus: 'composer' | 'message' } | null {
  const reference = useSourceReference(nodeId);
  const getFocus = useMemo(() => focusFor(nodeId), [nodeId]);
  const focus = useSyncExternalStore(subscribe, getFocus, getFocus);
  return useMemo(() => {
    if (reference && !claimed.has(reference.token)) return { token: reference.token, messageId: reference.messageId, focus: reference.focus };
    if (focus && !claimed.has(focus.token)) return { token: focus.token, messageId: null, focus: 'composer' };
    return null;
  }, [focus, reference]);
}

/** A conversation carries out a jump once; returning to it later keeps the user's own scroll. */
export function claimSourceJump(jump: number): void { claimed.add(jump); }

export function registerSourceNavigator(next: SourceNavigator): () => void {
  navigator = next;
  return () => { if (navigator === next) navigator = null; };
}

// Callers that only hand over a source (the shell's Space page, the chat
// window) still get the popover under the link they clicked.
let lastActivated: { element: HTMLElement; at: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a, [role="button"], [role="link"]') : null;
    if (element) lastActivated = { element, at: Date.now() };
  }, true);
}

function activatedElement(): HTMLElement | null {
  if (lastActivated && lastActivated.element.isConnected && Date.now() - lastActivated.at < 1_000) return lastActivated.element;
  const active = typeof document === 'undefined' ? null : document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function scrollParent(element: Element | null): HTMLElement | null {
  for (let current = element?.parentElement ?? null; current; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && current.scrollHeight > current.clientHeight) return current;
  }
  return null;
}

/** The scroller the user was reading, named so the page that replaces it can be found again. */
export function captureScroll(from: Element | null): SourceScroll | null {
  const fallback = typeof document === 'undefined' ? null : document.querySelector('.terminal-content-col .michi-doc');
  const scroller = scrollParent(from) ?? (fallback instanceof HTMLElement ? fallback : null);
  if (!scroller) return null;
  const plain = (name: string | undefined) => name && /^[A-Za-z][\w-]*$/.test(name) ? name : null;
  const name = plain(scroller.id) ? `#${scroller.id}` : plain(scroller.classList[0]) ? `.${scroller.classList[0]}` : null;
  return name ? { selector: `.terminal-content-col ${name}`, top: scroller.scrollTop } : null;
}

const RESTORE_FRAMES = 180;

/** Set the scroll position once the page has rendered enough to hold it; gives up after about three seconds. */
export function restoreScroll(scroll: SourceScroll): () => void {
  let frame = 0;
  let tries = 0;
  const step = () => {
    const element = document.querySelector<HTMLElement>(scroll.selector);
    if (element && element.scrollHeight - element.clientHeight >= scroll.top) {
      element.scrollTop = scroll.top;
      if (element.scrollTop >= scroll.top - 1) return;
    }
    if (++tries < RESTORE_FRAMES) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

export function openSourcePopover(input: { target: SourceTarget; anchor?: HTMLElement | null; page?: SourcePage | null }): void {
  const anchor = input.anchor ?? activatedElement();
  set({ popover: {
    target: input.target, anchor, page: input.page ?? null,
    origin: navigator?.currentOrigin() ?? null, scroll: captureScroll(anchor),
  } });
}

export function closeSourcePopover(): void {
  if (state.popover) set({ popover: null });
}

/**
 * The popover for a page change's exact source (`ExactPageSource`), as the
 * Space page, Home blocks and the chat window hand it over. `page` names the
 * page that cites it, for the "Referenced by" mark.
 */
export function openExactSourcePopover(
  identity: { backendConnectionId: string },
  source: { nodeId: string; turnId?: string; assistantId: string },
  options: { anchor?: HTMLElement | null; page?: SourcePage | null } = {},
): true {
  openSourcePopover({ target: { backendConnectionId: identity.backendConnectionId, nodeId: source.nodeId, messageId: source.assistantId }, ...options });
  return true;
}

/** Open the popover's conversation at its message: Continue puts the cursor in the composer, Open does not. */
export function openPopoverSource(
  focus: boolean,
  resolved?: { nodeId: string; workspaceId: string; messageId: string | null } | null,
): Promise<boolean> {
  const popover = state.popover;
  if (!popover) return Promise.resolve(false);
  set({ popover: null });
  return openConversationFromSpaces({
    ...popover.target,
    ...(resolved ? { nodeId: resolved.nodeId, workspaceId: resolved.workspaceId, messageId: resolved.messageId ?? popover.target.messageId } : {}),
    focus, page: popover.page, origin: popover.origin, scroll: popover.scroll,
  });
}

/**
 * Switch to the conversation area at a conversation (and its message, when
 * known), leaving a "Back to <page>" bar that returns to where Spaces was.
 * Resolves false when the conversation no longer exists.
 */
export async function openConversationFromSpaces(input: SourceTarget & {
  focus?: boolean;
  page?: SourcePage | null;
  anchor?: HTMLElement | null;
  origin?: SourceOrigin | null;
  scroll?: SourceScroll | null;
}): Promise<boolean> {
  const nav = navigator;
  if (!nav) return false;
  const origin = input.origin ?? nav.currentOrigin();
  const scroll = input.scroll !== undefined ? input.scroll : captureScroll(input.anchor ?? activatedElement());
  const connection = input.backendConnectionId;
  let nodeId = input.nodeId ? backendEntityId(connection, input.nodeId) : null;
  let workspaceId = input.workspaceId ? backendEntityId(connection, input.workspaceId) : null;
  let messageId = input.messageId ?? null;
  if (nodeId && !workspaceId) {
    const preview = await fetchSourcePreview(connection, { nodeId, messageId })
      .catch(() => null);
    if (preview) {
      nodeId = preview.nodeId;
      workspaceId = preview.workspaceId;
      messageId = preview.message?.id ?? messageId;
    }
  }
  if (!nodeId || !workspaceId) return failed();
  const previous = { back: state.back, reference: state.reference, focus: state.focus };
  const jump = ++token;
  set({
    back: origin ? { origin, scroll } : state.back,
    reference: messageId ? {
      nodeId, messageId, token: jump, focus: input.focus ? 'composer' : 'message',
      label: input.page ? input.page.title : null,
    } : null,
    focus: !messageId && input.focus ? { nodeId, token: jump } : null,
  });
  if (!await nav.reveal(workspaceId, nodeId)) {
    if (token === jump) set(previous);
    return failed();
  }
  if (messageId && input.page) {
    const page = input.page;
    void describePageReference(page, messageId).then((blocks) => {
      const current = state.reference;
      if (!blocks || !current || current.token !== jump) return;
      set({ reference: { ...current, label: `${page.title} · ${blocks}` } });
    }).catch(() => undefined);
  }
  return true;
}

function failed(): false {
  toast.error('This conversation is no longer available.');
  return false;
}

/** Back to the page the jump started from, at the scroll position it had. */
export function returnToSourceOrigin(): void {
  const back = state.back;
  if (!back) return;
  set({ back: null, reference: null, focus: null });
  navigator?.returnTo(back.origin);
  if (back.scroll) restoreScroll(back.scroll);
}

export function dismissSourceBack(): void {
  if (state.back || state.reference || state.focus) set({ back: null, reference: null, focus: null });
}

export function resetSourceNavForTests(): void {
  state = { popover: null, back: null, reference: null, focus: null };
  navigator = null;
  lastActivated = null;
  token = 0;
  claimed.clear();
}
