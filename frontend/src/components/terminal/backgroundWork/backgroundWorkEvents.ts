import { createContext, useContext } from 'react';

/**
 * The one way to open the Background work drawer. TerminalShell owns the
 * drawer and listens for this window event; the pane-title badge, the
 * top-bar background work button and the in-chat subagent / workflow cards
 * dispatch it on a user click. Nothing else may dispatch it: background
 * progress never opens the drawer.
 */
export const OPEN_BACKGROUND_WORK_EVENT = 'michi:open-background-work';

export type BackgroundWorkFocus =
  | { kind: 'subagent'; sessionId: string }
  | { kind: 'workflow'; runKey: string };

export interface OpenBackgroundWorkDetail {
  /** Conversation (chat node) the drawer is scoped to. */
  nodeId: string;
  /** Item to expand and scroll into view. */
  focus?: BackgroundWorkFocus;
}

export function openBackgroundWork(detail: OpenBackgroundWorkDetail): void {
  window.dispatchEvent(new CustomEvent<OpenBackgroundWorkDetail>(OPEN_BACKGROUND_WORK_EVENT, { detail }));
}

function readFocus(value: unknown): BackgroundWorkFocus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const focus = value as Record<string, unknown>;
  if (focus.kind === 'subagent' && typeof focus.sessionId === 'string' && focus.sessionId) {
    return { kind: 'subagent', sessionId: focus.sessionId };
  }
  if (focus.kind === 'workflow' && typeof focus.runKey === 'string' && focus.runKey) {
    return { kind: 'workflow', runKey: focus.runKey };
  }
  return undefined;
}

/** Validated event detail, or null for a malformed event. */
export function readOpenBackgroundWorkDetail(event: Event): OpenBackgroundWorkDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== 'object') return null;
  const { nodeId, focus } = detail as Record<string, unknown>;
  if (typeof nodeId !== 'string' || !nodeId) return null;
  const parsed = readFocus(focus);
  return parsed ? { nodeId, focus: parsed } : { nodeId };
}

/** Subscribe to open requests; returns the unsubscribe function. */
export function onOpenBackgroundWork(handler: (detail: OpenBackgroundWorkDetail) => void): () => void {
  const listener = (event: Event) => {
    const detail = readOpenBackgroundWorkDetail(event);
    if (detail) handler(detail);
  };
  window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
  return () => window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
}

/**
 * The chat node whose transcript is rendering, for in-chat cards deep in the
 * message tree. Provided by PaneMessageList; null elsewhere (specimens,
 * provider-free tests), where cards render without the drawer link.
 */
export const BackgroundWorkNodeContext = createContext<string | null>(null);

export function useBackgroundWorkNodeId(): string | null {
  return useContext(BackgroundWorkNodeContext);
}
