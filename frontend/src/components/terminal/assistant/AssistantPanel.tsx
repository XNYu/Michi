import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { AnimatePresence, PresenceContext, motion, useIsPresent, type Variants } from 'motion/react';
import { EASE, TRANSITION } from '../../../motion/tokens';
import TPane from '../TPane';
import { MichiSectionLabel } from '../content/MichiSectionLabel';
import { BorderBtn } from '../primitives';
import { ExternalLinkIcon } from '../icons';
import { AssistantLinkScope } from './AssistantLinks';
import type { PageId } from '../../../state/commands';
import {
  chatLabel,
  useChatActions,
  useChatNodeReader,
  useChatPanes,
  useChatProjects,
  useStructuralSelector,
} from '../../../state/chatStore';
import type { ChatNodeState, ComposerDraft } from '../../../state/chatTypes';
import { navigateToNode } from '../../../state/navigateToNode';
import {
  MICHI_ASSISTANT_OPEN_EVENT,
  type MichiAssistantPage,
  type OpenMichiAssistantOptions,
} from '../../../state/content/assistantBridge';
import { AssistantApiError, MICHI_ASSISTANT_RESET_EVENT, resetAssistant, type AssistantInfo } from '../../../services/api/assistant';
import {
  adoptAssistantInfo,
  closeAssistantPanel,
  getAssistantSnapshot,
  loadAssistant,
  openAssistantPanel,
  subscribeAssistant,
  useAssistantSnapshot,
} from '../../../state/assistant/assistantStore';
import { composerKeptEscape, isComposerEditorEvent } from '../../composerEscape';
import { MENU_LAYER_SELECTOR, OTHER_LAYER_SELECTOR, isInAssistantPanel } from '../escapeLayers';
import { useAssistantNode } from '../../../state/assistant/useAssistantNode';
import {
  addAssistantAttachments,
  injectedAssistantDraftIsStale,
  isUntouchedInjectedDraft,
  noteAssistantDraftInjected,
  requestAssistantSend,
  setAssistantPage,
  takeInjectedAssistantDraft,
  useAssistantComposer,
} from '../../../state/assistant/assistantComposer';
import { assistantPageCaption, assistantPageKey, type AssistantPageView } from '../../../state/assistant/assistantContext';
import { rememberUserWorkspace } from '../../../state/assistant/userWorkspace';
import './assistant.css';

/** How long the first open waits for the backend before showing a skeleton. */
export const FIRST_PROBE_GRACE_MS = 250;

/**
 * ⌘J opens and closes the panel many times a day: short, no bounce, grown
 * from its bottom-right anchor. A second ⌘J mid-way reverses it in place
 * (AnimatePresence brings the leaving panel back).
 */
const PANEL_VARIANTS: Variants = {
  hidden: { opacity: 0, scale: 0.97, y: 6 },
  shown: { opacity: 1, scale: 1, y: 0, transition: { duration: 0.16, ease: EASE.out } },
  gone: { opacity: 0, scale: 0.98, y: 4, transition: TRANSITION.exit },
};
const PANEL_ORIGIN = { originX: 1, originY: 1 } as const;
const LEAVING_STYLE = { ...PANEL_ORIGIN, pointerEvents: 'none' } as const;
/** The conversation replacing the skeleton. */
const CONTENT_FADE = { duration: 0.12, ease: 'linear' } as const;

/**
 * An Esc pressed outside the panel (focus on the page, not in a text field)
 * that should close it: the panel is on screen and is the top layer. The
 * shell asks before its own Esc (leaving a page), so the floating panel goes
 * first; a menu, list or dialog that is open keeps the key.
 */
export function assistantPanelTakesEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (!getAssistantSnapshot().open || !document.querySelector('[data-assistant-panel]')) return false;
  if (event.target instanceof Element && isInAssistantPanel(event.target)) return false;
  return !document.querySelector(OTHER_LAYER_SELECTOR);
}

function samePageView(a: AssistantPageView | null, b: AssistantPageView | null): boolean {
  return (a?.kind ?? null) === (b?.kind ?? null)
    && (a?.projectId ?? null) === (b?.projectId ?? null)
    && (a?.nodeId ?? null) === (b?.nodeId ?? null)
    && (a?.title ?? null) === (b?.title ?? null);
}

/** The page the user is on, resolved to something the assistant can name. */
function useLivePage(page: PageId, assistantNodeId: string | null): AssistantPageView {
  const { focusedPane, openPanes } = useChatPanes();
  const { projects, activeProjectId } = useChatProjects();
  // The grid with no pane left shows Home (Dashboard, Topbar's dashboardShowsHome):
  // closing the last pane, the assistant's own included, lands there.
  const activeTreeId = projects.find((p) => p.id === activeProjectId)?.activeTreeId;
  const gridShowsHome = page === 'dashboard' && openPanes.length === 0 && activeTreeId != null;
  const paneTitle = useStructuralSelector(
    useCallback((nodes: Record<string, ChatNodeState>) => {
      const node = focusedPane ? nodes[focusedPane] : undefined;
      return node ? node.title || chatLabel(node) : null;
    }, [focusedPane]),
  );
  const view: AssistantPageView = (() => {
    switch (page) {
      case 'home': return { kind: 'home' };
      case 'threads': return { kind: 'threads' };
      case 'dashboard':
        if (gridShowsHome) return { kind: 'home' };
        // No chat pane in focus, or the assistant's own pane: nothing to name.
        if (!focusedPane || paneTitle === null || focusedPane === assistantNodeId) return { kind: 'other' };
        return { kind: 'pane', nodeId: focusedPane, title: paneTitle };
      default: return { kind: 'other' };
    }
  })();
  const stable = useRef(view);
  if (!samePageView(stable.current, view)) stable.current = view;
  return stable.current;
}

function resolveRequestedPage(
  requested: MichiAssistantPage,
  live: AssistantPageView | null,
): AssistantPageView {
  if (live && live.kind === requested.kind
    && (live.projectId ?? null) === (requested.projectId ?? live.projectId ?? null)
    && (live.nodeId ?? null) === (requested.nodeId ?? live.nodeId ?? null)) return live;
  return { ...requested };
}

/** Focus the composer once TPane's lazy editor is in; gives up quietly. */
function focusComposerSoon(root: HTMLElement | (() => HTMLElement | null) | null): () => void {
  let tries = 0;
  let timer = 0;
  const attempt = () => {
    const el = typeof root === 'function' ? root() : root;
    const editor = el?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editor) {
      editor.focus();
      return;
    }
    if (tries++ < 40) timer = window.setTimeout(attempt, 50);
  };
  attempt();
  return () => window.clearTimeout(timer);
}

/**
 * The assistant's pane in the grid (not the panel's own TPane, also while the
 * panel is leaving and no longer carries data-assistant-panel).
 */
function gridPaneElement(nodeId: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-node-id]')) {
    if (el.dataset.nodeId === nodeId && !isInAssistantPanel(el) && !el.closest('.assistant-panel')) return el;
  }
  return null;
}

type SetComposerDraft = (nodeId: string, draft: ComposerDraft | null) => void;

/**
 * Open requests (Ask on a block, Hand to agent…) land on the assistant's
 * node: page and chips into its composer store, a prompt into its draft, or,
 * when the caller asked to send, a send its TPane makes through the normal
 * send path (runtime binding, context quote, queue while it answers).
 * `trackPrompt`: a prompt left in the floating panel's composer belongs to
 * the page it was asked on (see dropStaleInjectedDraft).
 */
function applyAssistantRequests(
  nodeId: string,
  requests: readonly OpenMichiAssistantOptions[],
  livePage: AssistantPageView | null,
  setComposerDraft: SetComposerDraft,
  trackPrompt: boolean,
): void {
  for (const request of requests) {
    if (request.page) setAssistantPage(nodeId, resolveRequestedPage(request.page, livePage));
    if (request.attachments?.length) addAssistantAttachments(nodeId, request.attachments);
    const prompt = request.prompt?.trim();
    if (!prompt) continue;
    if (request.send) {
      requestAssistantSend(nodeId, prompt);
      continue;
    }
    setComposerDraft(nodeId, { value: prompt, mentions: [] });
    if (trackPrompt) noteAssistantDraftInjected(nodeId, prompt);
    else takeInjectedAssistantDraft(nodeId);
  }
}

/**
 * A prompt a caller put in the composer ("A conversation is missing from
 * this workspace:") is cleared once its moment is over (its page is gone,
 * the panel was dismissed), but only if the composer still holds exactly
 * that prompt: text the user typed or edited always stays.
 */
function dropStaleInjectedDraft(
  nodeId: string,
  readNode: (nodeId: string) => ChatNodeState | undefined,
  setComposerDraft: SetComposerDraft,
): void {
  const injected = takeInjectedAssistantDraft(nodeId);
  if (injected && isUntouchedInjectedDraft(injected, readNode(nodeId)?.composerDraft)) setComposerDraft(nodeId, null);
}

/**
 * Whether closing the panel hands focus back to where it was before it
 * opened. A dismissal does (Esc, ×, ⌘J, ⌘W); leaving for the assistant's
 * pane doesn't.
 */
let returnFocusOnClose = true;

function AssistantPanel({
  info,
  status,
  error,
  livePage,
  takeRequests,
  requestSeq,
  openFocusSeq,
}: {
  info: AssistantInfo | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  livePage: AssistantPageView | null;
  takeRequests: () => OpenMichiAssistantOptions[];
  requestSeq: number;
  /** AssistantSnapshot.focusSeq: bumped by each explicit open. */
  openFocusSeq: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  // False while the closed panel plays its exit: it is no longer a layer then
  // (no Esc, ⌘W, focus or pointer), only its picture fading out.
  const present = useIsPresent();
  const nodeId = info?.nodeId ?? null;
  const { state: nodeState, retry: retryNode } = useAssistantNode(info);
  const ready = status === 'ready' && nodeState === 'ready' && !!nodeId;
  // The conversation fades in over a skeleton or error line this panel showed.
  const [placeholderShown, setPlaceholderShown] = useState(!ready);
  if (!ready && !placeholderShown) setPlaceholderShown(true);
  const composer = useAssistantComposer(nodeId);
  // Telling an injected prompt from the user's text reads the draft as the
  // store holds it at that moment: every edit lands there synchronously,
  // while this panel's renders (and React's) can trail an edit by a frame.
  const readNode = useChatNodeReader();
  const { projects, activeProjectId } = useChatProjects();
  const {
    selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId, setComposerDraft,
  } = useChatActions();

  // What's on screen follows the user while the panel is open (not while it
  // leaves: "Open as pane" has just told the assistant there is no page).
  useEffect(() => {
    if (present && nodeId && livePage) setAssistantPage(nodeId, livePage);
  }, [present, nodeId, livePage]);

  // A prompt put in the composer for a page the user has left goes, unless
  // they made it their own. Reads the store, not this render: a request
  // that just landed may have moved the page and set the prompt.
  const pageKey = assistantPageKey(composer.page);
  useEffect(() => {
    if (nodeId && injectedAssistantDraftIsStale(nodeId)) dropStaleInjectedDraft(nodeId, readNode, setComposerDraft);
  }, [nodeId, pageKey, readNode, setComposerDraft]);

  // Dismissing the panel (Esc, ×, ⌘J, ⌘W) ends a prompt's moment too;
  // leaving for the assistant's pane takes the draft along. Judged the
  // moment the panel closes (a store listener, not an unmount cleanup,
  // which StrictMode also runs on mount).
  useEffect(() => {
    if (!nodeId) return undefined;
    return subscribeAssistant(() => {
      if (getAssistantSnapshot().open) return;
      if (returnFocusOnClose) dropStaleInjectedDraft(nodeId, readNode, setComposerDraft);
      else takeInjectedAssistantDraft(nodeId);
    });
  }, [nodeId, readNode, setComposerDraft]);

  // Closing hands focus back to where it was when the panel opened, when it
  // is still inside the panel (a dismissal, not a click elsewhere). This
  // happens the moment the panel closes (presence ends), not after its exit,
  // and in the layout phase: React puts back the focus it saw before the
  // commit, and the leaving panel's composer is still in the document. The
  // leaving panel is then inert. A ⌘J that brings it back notes again where
  // the focus is to return to.
  const returnToRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (present) {
      const previous = document.activeElement;
      returnToRef.current = previous instanceof HTMLElement && previous !== document.body && !isInAssistantPanel(previous)
        ? previous
        : null;
      returnFocusOnClose = true;
      return undefined;
    }
    if (!root) return undefined;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.contains(focused)) {
      const returnTo = returnToRef.current;
      if (returnFocusOnClose && returnTo?.isConnected) returnTo.focus();
      else focused.blur();
    }
    root.setAttribute('inert', '');
    return () => root.removeAttribute('inert');
  }, [present]);
  // Unmounted while still open (the shell leaves for Spaces): the same hand-back.
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      const returnTo = returnToRef.current;
      if (!returnFocusOnClose || !returnTo?.isConnected) return;
      if (root?.contains(document.activeElement)) returnTo.focus();
    };
  }, []);

  // Open requests (Ask on a block, Hand to agent…) wait for the node.
  const [requestFocusSeq, setRequestFocusSeq] = useState(0);
  useEffect(() => {
    if (!present || !ready || !nodeId) return;
    const requests = takeRequests();
    if (requests.length === 0) return;
    applyAssistantRequests(nodeId, requests, livePage, setComposerDraft, true);
    setRequestFocusSeq((n) => n + 1);
    // takeRequests drains a ref; requestSeq says there is something new in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, ready, nodeId, requestSeq]);

  // The composer takes focus when the user opens the panel and after a request
  // lands — not when the panel comes back after a reload or follows a reset,
  // which would pull focus out of whatever pane the user is in.
  const focusKey = `${openFocusSeq}:${requestFocusSeq}`;
  const focusedKeyRef = useRef('0:0');
  useEffect(() => {
    if (!present || !ready || focusKey === focusedKeyRef.current) return;
    focusedKeyRef.current = focusKey;
    return focusComposerSoon(rootRef.current);
  }, [present, ready, focusKey]);

  const expand = () => {
    if (!info) return;
    // The assistant's workspace becomes the active one; New thread, Home and
    // the thread views come back to the user's.
    rememberUserWorkspace(projects.find((p) => p.id === activeProjectId));
    returnFocusOnClose = false;
    navigateToNode(
      { projects, activeProjectId, selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId },
      info.nodeId,
      info.workspaceId,
    );
    // The assistant itself is on screen now; no page to tell it about.
    setAssistantPage(info.nodeId, null);
    window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'dashboard' } }));
    closeAssistantPanel();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Esc that ends an IME composition belongs to the composition.
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    // ProseMirror prevents the default of every Escape, so the composer says
    // when it kept one (its own popup, a composition). Anything else that
    // handled an Escape prevents its default.
    const handled = isComposerEditorEvent(e.nativeEvent) ? composerKeptEscape(e.nativeEvent) : e.defaultPrevented;
    if (handled) return;
    // A menu, list or modal over the panel owns Esc (a non-modal drawer
    // doesn't), and so does a layer that closes on any Esc while it is up, on
    // top of the panel: `data-escape-layer="over"` (the selection toolbar). One
    // under it ("pane": a find bar; "shell": the narrow sidebar overlay) counts
    // only inside the panel, so a find bar left open behind the panel doesn't
    // take the Esc pressed in its composer. One Esc closes one thing.
    if (document.querySelector(MENU_LAYER_SELECTOR) || rootRef.current?.querySelector('[data-escape-layer]')) return;
    e.preventDefault();
    e.stopPropagation();
    closeAssistantPanel();
  };

  // Starting over, which Settings used to offer: the old conversation stays in history.
  const answering = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => !!nodeId && nodes[nodeId]?.status === 'streaming', [nodeId]));
  const [starting, setStarting] = useState(false);
  const startOver = async () => {
    if (!nodeId || starting) return;
    setStarting(true);
    try {
      const next = await resetAssistant(nodeId);
      adoptAssistantInfo(next);
      window.dispatchEvent(new CustomEvent<AssistantInfo>(MICHI_ASSISTANT_RESET_EVENT, { detail: next }));
      setRequestFocusSeq((n) => n + 1);
    } catch (cause) {
      // Another window already started over: show the conversation that is current now.
      if (cause instanceof AssistantApiError && cause.current) adoptAssistantInfo(cause.current);
      else toast.error(cause instanceof Error ? cause.message : 'Could not start a new conversation');
    } finally {
      setStarting(false);
    }
  };

  const caption = assistantPageCaption(composer.page);
  return (
    <motion.div
      ref={rootRef}
      className="assistant-panel"
      role="complementary"
      aria-label="Assistant"
      // Esc and ⌘W find the panel by this attribute: the leaving one is not it.
      data-assistant-panel={present ? '' : undefined}
      aria-hidden={present ? undefined : true}
      variants={PANEL_VARIANTS}
      initial="hidden"
      animate="shown"
      exit="gone"
      style={present ? PANEL_ORIGIN : LEAVING_STYLE}
      onKeyDown={onKeyDown}
    >
      {/* The panel's own presence stops here: the conversation's motion
          (TPane) enters and leaves as it does in a grid pane, neither held
          by the panel's exit nor kept from animating after a reload. */}
      <PresenceContext.Provider value={null}>
        <div className="assistant-panel__head">
          <MichiSectionLabel label={caption ? `Assistant · on ${caption}` : 'Assistant'} />
          <button
            type="button"
            className="assistant-panel__btn"
            aria-label="New conversation"
            title="New conversation"
            aria-busy={starting || undefined}
            disabled={!ready || answering || starting}
            onClick={() => { void startOver(); }}
          >
            <Plus size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="assistant-panel__btn"
            aria-label="Open as pane"
            title="Open as pane"
            disabled={!ready}
            onClick={expand}
          >
            <ExternalLinkIcon size={12} />
          </button>
          <button
            type="button"
            className="assistant-panel__btn"
            aria-label="Close"
            title="Close"
            onClick={closeAssistantPanel}
          >
            ×
          </button>
        </div>
        <motion.div
          key={ready && nodeId ? 'conversation' : 'status'}
          className="assistant-panel__body"
          initial={ready && placeholderShown ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={CONTENT_FADE}
        >
          {ready && nodeId ? (
            <AssistantLinkScope>
              {/* A message sent while starting over would land in the conversation being archived. */}
              <TPane nodeId={nodeId} embedded composerDisabled={starting} />
            </AssistantLinkScope>
          ) : status === 'error' || nodeState === 'failed' ? (
            <div className="assistant-panel__status">
              <div className="assistant-panel__line" role="status">
                <span title={status === 'error' ? error ?? undefined : undefined}>
                  {status === 'error' ? "Couldn't reach the assistant" : "Couldn't load the conversation"}
                </span>
                <BorderBtn onClick={() => { if (status === 'error') void loadAssistant(); else retryNode(); }}>Retry</BorderBtn>
              </div>
            </div>
          ) : (
            <div className="assistant-panel__status" aria-busy="true" aria-label="Loading the assistant">
              <div className="assistant-skeleton" style={{ width: '62%' }} />
              <div className="assistant-skeleton" style={{ width: '84%' }} />
              <div className="assistant-skeleton" style={{ width: '48%' }} />
            </div>
          )}
        </motion.div>
      </PresenceContext.Provider>
    </motion.div>
  );
}

/**
 * The ⌘J assistant panel: a floating card bottom-right holding the
 * assistant's conversation (a normal TPane), opened by ⌘J, the palette or
 * `openMichiAssistant()`. Renders nothing while closed, and never when the
 * backend has no assistant.
 */
export function AssistantPanelHost({ page }: { page: PageId }) {
  const snap = useAssistantSnapshot();
  const requestsRef = useRef<OpenMichiAssistantOptions[]>([]);
  const [requestSeq, setRequestSeq] = useState(0);
  const livePage = useLivePage(page, snap.info?.nodeId ?? null);

  useEffect(() => {
    if (snap.open) void loadAssistant();
  }, [snap.open]);

  // A request belongs to the moment it was made: closing the panel, or a load
  // that ends without an assistant, drops it rather than sending it later.
  const prevStatusRef = useRef(snap.status);
  useEffect(() => {
    const failed = snap.status !== prevStatusRef.current && (snap.status === 'error' || snap.status === 'unsupported');
    prevStatusRef.current = snap.status;
    if (!snap.open || failed) requestsRef.current = [];
  }, [snap.open, snap.status]);

  useEffect(() => {
    const onOpen = (event: Event) => {
      if (!openAssistantPanel()) return;
      requestsRef.current.push((event as CustomEvent<OpenMichiAssistantOptions | undefined>).detail ?? {});
      setRequestSeq((n) => n + 1);
      void loadAssistant();
    };
    const onReset = (event: Event) => adoptAssistantInfo((event as CustomEvent<unknown>).detail);
    window.addEventListener(MICHI_ASSISTANT_OPEN_EVENT, onOpen);
    window.addEventListener(MICHI_ASSISTANT_RESET_EVENT, onReset);
    return () => {
      window.removeEventListener(MICHI_ASSISTANT_OPEN_EVENT, onOpen);
      window.removeEventListener(MICHI_ASSISTANT_RESET_EVENT, onReset);
    };
  }, []);

  const takeRequests = useCallback(() => {
    const requests = requestsRef.current;
    requestsRef.current = [];
    return requests;
  }, []);

  // The assistant already open as a pane in the grid on screen: opening the
  // panel would mount a second conversation view on the same node. Its pane
  // takes the focus (and any request) instead.
  const { openPanes } = useChatPanes();
  const { focusPane, setComposerDraft } = useChatActions();
  const assistantNodeId = snap.info?.nodeId ?? null;
  const inGrid = page === 'dashboard' && !!assistantNodeId && openPanes.includes(assistantNodeId);
  useEffect(() => {
    if (!snap.open || !inGrid || !assistantNodeId) return;
    applyAssistantRequests(assistantNodeId, takeRequests(), null, setComposerDraft, false);
    returnFocusOnClose = false;
    closeAssistantPanel();
    focusPane(assistantNodeId);
    focusComposerSoon(() => gridPaneElement(assistantNodeId));
    // A new open (focusSeq) or request (requestSeq) runs this again.
  }, [snap.open, snap.focusSeq, requestSeq, inGrid, assistantNodeId, takeRequests, setComposerDraft, focusPane]);

  // Until the backend first answers, the panel waits a moment before showing
  // its skeleton: a backend without an assistant answers 404 well within it,
  // so the panel never flashes there.
  const probing = snap.open && !snap.info && (snap.status === 'idle' || snap.status === 'loading');
  const [probeShown, setProbeShown] = useState(false);
  useEffect(() => {
    if (!probing) {
      setProbeShown(false);
      return;
    }
    const timer = window.setTimeout(() => setProbeShown(true), FIRST_PROBE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [probing]);

  const { status } = snap;
  const shown = snap.open && !inGrid && status !== 'unsupported' && !(probing && !probeShown);
  // Handed to its pane in the grid ("Open as pane", the pane already there):
  // the panel goes in the same commit as the pane comes, with no exit. Its
  // TPane saves the scroll position on unmount that the pane's TPane then
  // restores on mount; a panel still on screen would leave an older one.
  // A new key unmounts AnimatePresence and the leaving panel with it.
  const [presenceKey, setPresenceKey] = useState(0);
  const [seen, setSeen] = useState({ shown, inGrid });
  if (seen.shown !== shown || seen.inGrid !== inGrid) {
    setSeen({ shown, inGrid });
    if ((seen.shown && !shown && !returnFocusOnClose) || (inGrid && !seen.inGrid)) setPresenceKey((n) => n + 1);
  }
  return (
    <AnimatePresence key={presenceKey} initial={false}>
      {status !== 'unsupported' && shown ? (
        <AssistantPanel
          key="assistant-panel"
          info={snap.info}
          status={status}
          error={snap.error}
          livePage={livePage}
          takeRequests={takeRequests}
          requestSeq={requestSeq}
          openFocusSeq={snap.focusSeq}
        />
      ) : null}
    </AnimatePresence>
  );
}
