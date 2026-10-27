import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Sparkles, X } from 'lucide-react';
import TPane from '../../TPane';
import { AssistantLinkChip, AssistantLinkScope } from '../../assistant/AssistantLinks';
import { MarkdownLinkRendererContext, type MarkdownLinkRenderer } from '../../../markdownLinkRenderer';
import { useChatActions, useChatNodesSnapshot, useChatProjects, useStructuralSelector } from '../../../../state/chatStore';
import type { ChatMessage, ChatNodeState } from '../../../../state/chatTypes';
import {
  adoptAssistantInfo,
  closeAssistantPanel,
  getAssistantSnapshot,
  loadAssistant,
  setAssistantShownElsewhere,
  subscribeAssistant,
  useAssistantSnapshot,
} from '../../../../state/assistant/assistantStore';
import { useAssistantNode } from '../../../../state/assistant/useAssistantNode';
import { requestAssistantSend, setAssistantPage } from '../../../../state/assistant/assistantComposer';
import { parseAssistantLink } from '../../../../state/assistant/assistantLinks';
import { consumePageHelperDraft, PAGE_HELPER_DRAFT_EVENT, pendingPageHelperDrafts } from '../../../../state/pages/pageHelperDraft';
import { useSpaceTopbar } from '../../../../state/pages/spaceTopbar';
import { fetchAssistant, resetAssistant, MICHI_ASSISTANT_RESET_EVENT, provideMetaAgentTurnContext } from '../../../../services/api/assistant';
import { META_AGENT_GUARD_ERROR_CODE } from 'michi-shared';
import type { MetaChatWindowController } from '../../../../state/metaChat/useMetaChatWindow';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../../../state/metaChat/metaChatDecorations';
import { metaAgentToolLine } from '../../../../state/metaChat/toolLines';
import { loadSpacesHomeIds, subscribeKnownSpacesPages, getSpacesHomeIds, knownSpacesPages } from '../../../../state/metaChat/spacesPages';
import { SPACES_SUGGESTIONS, visibleSuggestions } from '../../../../state/metaChat/suggestions';
import { subscribePageCards } from '../../../../state/metaChat/pageCardStates';
import { buildMetaAgentTurnContext, viewPageId, type MetaChatView } from '../../../../state/metaChat/turnContext';
import { requestMetaAgentSettings } from '../../scheduled/metaAgent/metaAgentNav';
import { refreshMetaAgent } from '../../../../state/metaAgent/useMetaAgent';
import { useLayoutRules } from '../layoutRules/useLayoutRules';
import { useSpacesFirstRun } from '../../../../state/metaAgent/spacesFirstRun';
import { REMOTE_SPACES_NOTE, spacesSupportsConnection } from '../../../../state/metaAgent/remoteSpaces';
import { backendConnectionIdForWorkspace } from '../../../../config/backendConnections';
import { openConversationFromSpaces } from '../../../../state/sourceNav/sourceNav';
import {
  fetchWindowConversation,
  firstRunOpensWindow,
  firstRunProgressKey,
  noteFirstRunOpenedWindow,
  windowConversationActions,
  type NarrationOption,
} from '../../../../state/metaChat/firstRunWindow';
import { MetaChatArea } from './MetaChatArea';
import { MetaChatSuggestions } from './MetaChatPanel';
import { MetaChatCards, type MetaChatCardsContext } from './MetaChatCards';
import { openWindowSource, type MetaChatSourceRequest } from './openSourcePopover';

/** A page block the next message is about. */
export interface MetaChatBlockTarget {
  backendConnectionId: string;
  workspaceId: string;
  pageId: string;
  blockId: string;
  title: string;
  content: string;
}

/** What the Spaces main area shows. */
export type SpacesChatView = MetaChatView;

export interface MetaChatTargeting {
  target: MetaChatBlockTarget | null;
  setTarget: (target: MetaChatBlockTarget | null) => void;
  /** Targets the block and puts the cursor in the window's input. */
  askAbout: (target: MetaChatBlockTarget) => void;
  /** Visible choices send; action/form prompts fill the composer for review. */
  respondToBlock?: (target: MetaChatBlockTarget, prompt: string, send: boolean) => boolean;
}

/** A conversation message a reply cites: the window hands it to the source popover. */
export type MetaChatSource = MetaChatSourceRequest;

const MetaChatTargetContext = createContext<MetaChatTargeting | null>(null);

/** Block targeting for pages shown in Spaces; null outside the Spaces area. */
export function useMetaChatTargeting(): MetaChatTargeting | null {
  return useContext(MetaChatTargetContext);
}

export { SPACES_SUGGESTIONS };

function viewKey(view: SpacesChatView): string {
  if (view.kind === 'page') return `page:${view.backendConnectionId}:${view.workspaceId}:${view.pageId}`;
  return view.kind === 'workspace' ? `workspace:${view.workspaceId}` : 'home';
}

function textOf(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (children && typeof children === 'object' && 'props' in children) return textOf((children as { props: { children?: ReactNode } }).props.children);
  return '';
}

const NO_MESSAGES: ChatMessage[] = [];
type OpenOption = NonNullable<NarrationOption['open']>;
const NO_OPEN_OPTIONS: ReadonlyMap<string, OpenOption> = new Map();

/**
 * The Spaces main area with the Meta agent window. The window shows the
 * assistant's conversation and sends through its composer store; every
 * message carries the page on screen, the selected block and the known pages.
 * Stays mounted outside Spaces (`active` false) so the window keeps its draft.
 */
export function SpacesMetaChat({ controller, active, view, onOpenSource = openWindowSource, children }: {
  controller: MetaChatWindowController;
  active: boolean;
  view: SpacesChatView;
  /** A cited conversation message was clicked; true when it was shown (else the link opens the conversation). */
  onOpenSource?: (source: MetaChatSource) => boolean;
  children: ReactNode;
}) {
  const snap = useAssistantSnapshot();
  const info = snap.info;
  const nodeId = info?.nodeId ?? null;
  const { agentStatus, projects } = useChatProjects();
  const spacePage = useSpaceTopbar();
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  useEffect(() => {
    if (active) void loadAssistant();
  }, [active]);

  useEffect(() => {
    if (active) void refreshMetaAgent();
  }, [active]);

  // The home page ids name the Spaces Home and workspace homes in each message's context.
  useEffect(() => {
    if (!active) return undefined;
    void loadSpacesHomeIds();
    const reload = () => { void loadSpacesHomeIds(true); };
    window.addEventListener('michi:page-changed', reload);
    return () => window.removeEventListener('michi:page-changed', reload);
  }, [active]);

  // Whatever page the floating assistant last named is not what Spaces shows.
  useEffect(() => {
    if (active && nodeId) setAssistantPage(nodeId, { kind: 'other' });
  }, [active, nodeId]);

  // While the window shows the conversation, its replies are in view: no "Streaming finished" notice.
  const shown = active && !controller.state.minimized;
  useEffect(() => {
    if (!shown || !nodeId) return undefined;
    setAssistantShownElsewhere(nodeId, true);
    return () => setAssistantShownElsewhere(nodeId, false);
  }, [nodeId, shown]);

  // In Spaces an explicit open of the assistant (palette, a revealed reply) lands in this window.
  useEffect(() => {
    if (!active) return undefined;
    let seen = getAssistantSnapshot().focusSeq;
    return subscribeAssistant(() => {
      const next = getAssistantSnapshot();
      if (next.focusSeq === seen) return;
      seen = next.focusSeq;
      if (!next.open) return;
      closeAssistantPanel();
      controllerRef.current.focusInput();
    });
  }, [active]);

  const key = viewKey(view);
  const [targetState, setTargetState] = useState<{ key: string; target: MetaChatBlockTarget | null }>({ key, target: null });
  if (targetState.key !== key) setTargetState({ key, target: null });
  const target = targetState.key === key ? targetState.target : null;
  const setTarget = useCallback((next: MetaChatBlockTarget | null) => setTargetState({ key, target: next }), [key]);
  const askAbout = useCallback((next: MetaChatBlockTarget) => {
    setTargetState({ key, target: next });
    controllerRef.current.focusInput();
  }, [key]);


  // "Ask" from a database or component block prefills the window's input.
  const [draftRequest, setDraftRequest] = useState<{ id: number; text: string } | null>(null);
  const pageIdentity = view.kind === 'page' ? view : null;
  useEffect(() => {
    if (!active || !pageIdentity) return undefined;
    const identity = { backendConnectionId: pageIdentity.backendConnectionId, workspaceId: pageIdentity.workspaceId, pageId: pageIdentity.pageId };
    const drain = () => {
      const pending = pendingPageHelperDrafts(identity);
      const last = pending[pending.length - 1];
      if (!last) return;
      for (const request of pending) if (request.requestId !== undefined) consumePageHelperDraft(request.requestId);
      if (last.blockContext) setTargetState({ key, target: { ...identity, ...last.blockContext } });
      setDraftRequest({ id: last.requestId ?? 0, text: last.text });
      controllerRef.current.focusInput();
    };
    window.addEventListener(PAGE_HELPER_DRAFT_EVENT, drain);
    drain();
    return () => window.removeEventListener(PAGE_HELPER_DRAFT_EVENT, drain);
    // The identity is fully described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key]);

  // Each message to the assistant carries what the window sees at the moment it is sent.
  const workspaces = useMemo(
    () => projects.filter((p) => !p.system && !p.deletedAt && !p.id.startsWith('remote:')).map((p) => ({ id: p.id, name: p.name })),
    [projects],
  );
  // Spaces doesn't support remote connections yet: the Meta agent is told their names so it can say so when asked.
  const remoteWorkspaces = useMemo(
    () => projects.filter((p) => !p.system && !p.deletedAt && !p.archivedAt && !spacesSupportsConnection(backendConnectionIdForWorkspace(p.id)))
      .map((p) => ({ id: p.id, name: p.name })),
    [projects],
  );
  const contextRef = useRef({ view, target, workspaces, remoteWorkspaces });
  contextRef.current = { view, target, workspaces, remoteWorkspaces };
  useEffect(() => {
    if (!active || !nodeId) return undefined;
    return provideMetaAgentTurnContext(nodeId, () => buildMetaAgentTurnContext(contextRef.current));
  }, [active, nodeId]);

  const status = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => (nodeId ? nodes[nodeId]?.status : undefined),
    [nodeId],
  ));
  const errorKind = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => (nodeId ? nodes[nodeId]?.errorKind : undefined),
    [nodeId],
  ));
  const hasUserMessage = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => Boolean(nodeId && nodes[nodeId]?.messages.some((message) => message.role === 'user')),
    [nodeId],
  ));
  // Hide starters as soon as a send is queued; the durable transcript keeps them hidden after reload.
  const [submittedNodeId, setSubmittedNodeId] = useState<string | null>(null);
  const hasConversation = hasUserMessage || Boolean(nodeId && submittedNodeId === nodeId);
  const nodes = useChatNodesSnapshot();
  const busy = status === 'streaming';
  // Read per render: a turn ending (a structural change) re-renders with its tool calls.
  const messages = (nodeId ? nodes[nodeId]?.messages : undefined) ?? NO_MESSAGES;
  const guardFailed = status === 'error' && errorKind === META_AGENT_GUARD_ERROR_CODE;

  // A first run opens the window floating once, and the messages it posts are read back as it moves.
  const firstRun = useSpacesFirstRun('local');
  useEffect(() => {
    if (!active || !firstRunOpensWindow('local', firstRun.data)) return;
    noteFirstRunOpenedWindow('local', firstRun.data!.requestedAt!);
    controllerRef.current.showFloating();
  }, [active, firstRun.data]);

  const chatActions = useChatActions();
  const chatActionsRef = useRef(chatActions);
  chatActionsRef.current = chatActions;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const [openOptions, setOpenOptions] = useState<ReadonlyMap<string, OpenOption>>(NO_OPEN_OPTIONS);
  // The last message is a question the first run asked: its follow-up rows are its answers.
  const [question, setQuestion] = useState(false);
  const progressKey = firstRunProgressKey(firstRun.data);
  const treeId = info?.treeId;
  const conversationWorkspaceId = info?.workspaceId;
  useEffect(() => {
    if (!active || busy || !nodeId || !treeId || !conversationWorkspaceId) return undefined;
    const controller = new AbortController();
    fetchWindowConversation({ workspaceId: conversationWorkspaceId, treeId, nodeId }, controller.signal).then((fetched) => {
      if (controller.signal.aborted) return;
      const open = fetched.options.filter((option) => option.open);
      setOpenOptions(open.length ? new Map(open.map((option) => [option.label, option.open!])) : NO_OPEN_OPTIONS);
      setQuestion(fetched.options.length > 0);
      for (const action of windowConversationActions(nodesRef.current[nodeId], fetched)) chatActionsRef.current.dispatch(action);
    }, () => {});
    return () => controller.abort();
  }, [active, busy, nodeId, treeId, conversationWorkspaceId, progressKey]);

  // A question's "continue in that conversation" option opens it with the suggested text, unsent.
  const openOptionsRef = useRef(openOptions);
  openOptionsRef.current = openOptions;
  const onFollowUpCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const row = (event.target as Element).closest?.('.t-followup-row');
    const label = row?.querySelector('.t-followup-text')?.textContent?.trim();
    const option = label ? openOptionsRef.current.get(label) : undefined;
    if (!option) return;
    event.preventDefault();
    event.stopPropagation();
    void openConversationFromSpaces({ backendConnectionId: 'local', workspaceId: option.workspaceId, nodeId: option.nodeId, focus: true })
      .then((opened) => { if (opened) chatActionsRef.current.setComposerDraft(option.nodeId, { value: option.draft, mentions: [] }); });
  }, []);

  // After each turn: a runtime switch the turn made is in the assistant's info.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended || !active) return;
    const expectedNodeId = getAssistantSnapshot().info?.nodeId;
    fetchAssistant().then(next => {
      if (getAssistantSnapshot().info?.nodeId === expectedNodeId) adoptAssistantInfo(next);
    }, () => {});
    void refreshMetaAgent();
  }, [active, busy]);

  const runtimeName = useCallback(
    (runtimeId: string) => agentStatus?.availableRuntimes?.find((runtime) => runtime.id === runtimeId)?.label || runtimeId,
    [agentStatus?.availableRuntimes],
  );
  const pageName = view.kind === 'home' ? 'Home' : view.kind === 'workspace' ? view.name : spacePage?.title || 'Untitled page';

  // Names for tool lines: workspaces from the store, pages from what the sidebar knows.
  const [pagesVersion, setPagesVersion] = useState(0);
  const workspaceIds = useMemo(() => workspaces.map((w) => w.id), [workspaces]);
  useEffect(() => subscribeKnownSpacesPages(workspaceIds, () => setPagesVersion((v) => v + 1)), [workspaceIds]);
  const [cardsVersion, setCardsVersion] = useState(0);
  useEffect(() => subscribePageCards(() => setCardsVersion((v) => v + 1)), []);
  const currentPageId = useMemo(() => viewPageId(view), [view, pagesVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const switches = info?.runtimeSwitches;
  const decorations = useMemo<MetaChatDecorations>(() => {
    const pageTitles = new Map(knownSpacesPages(workspaces).map((p) => [p.id, p.title]));
    const homeId = getSpacesHomeIds().home?.id;
    const names = {
      workspace: (id: string) => workspaces.find((w) => w.id === id)?.name ?? null,
      page: (id: string) => (id === homeId ? 'Home' : pageTitles.get(id) ?? null),
    };
    const cardsContext: MetaChatCardsContext = {
      backendConnectionId: 'local',
      workspaceId: info?.workspaceId ?? '',
      currentPageId,
      runtimeLabel: runtimeName,
    };
    const byMessage = new Map((switches ?? []).map((s) => [s.afterMessageId, s]));
    return {
      assistantLabel: <span className="meta-chat-speaker"><Sparkles size={11} aria-hidden /> Michi</span>,
      toolLine: (tool) => metaAgentToolLine(tool, names),
      toolCards: (tools) => <MetaChatCards tools={tools} context={cardsContext} />,
      afterMessage: (message) => {
        const change = byMessage.get(message.id);
        return change
          ? <div className="meta-chat-runtime-switch" role="separator" aria-label={`From here on: ${runtimeName(change.runtimeId)}`}><span>From here on: {runtimeName(change.runtimeId)}</span></div>
          : null;
      },
    };
  }, [currentPageId, info?.workspaceId, pagesVersion, runtimeName, switches, workspaces]); // eslint-disable-line react-hooks/exhaustive-deps

  const onOpenSourceRef = useRef(onOpenSource);
  onOpenSourceRef.current = onOpenSource;
  const sourcePageRef = useRef<MetaChatSourceRequest['page']>(null);
  sourcePageRef.current = {
    pageId: currentPageId,
    workspaceId: view.kind === 'home' ? null : view.workspaceId,
    backendConnectionId: view.kind === 'page' ? view.backendConnectionId : 'local',
    title: pageName,
  };
  const links = useMemo<MarkdownLinkRenderer>(() => ({
    protocols: ['michi'],
    matches: (href) => parseAssistantLink(href) !== null,
    render: (href, children) => {
      const link = parseAssistantLink(href);
      if (!link) return children;
      if (link.kind !== 'node') return <AssistantLinkChip link={link}>{children}</AssistantLinkChip>;
      return (
        <span
          className="meta-chat-source"
          onClickCapture={(event) => {
            const source = {
              backendConnectionId: 'local', nodeId: link.id, ...(link.messageId ? { assistantId: link.messageId } : {}),
              title: textOf(children).trim(), page: sourcePageRef.current,
            };
            if (!onOpenSourceRef.current(source)) return;
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <AssistantLinkChip link={link}>{children}</AssistantLinkChip>
        </span>
      );
    },
  }), []);

  // A layout-rule suggestion follows the rules of the page on screen, read only where one is offered.
  const asksForRule = SPACES_SUGGESTIONS[view.kind].some((suggestion) => suggestion.rule);
  const { rules: layoutRules } = useLayoutRules(active && !hasConversation && asksForRule ? currentPageId : null, 'local');

  const remoteView = view.kind === 'page' ? !spacesSupportsConnection(view.backendConnectionId)
    : view.kind === 'workspace' && !spacesSupportsConnection(backendConnectionIdForWorkspace(view.workspaceId));
  // The suggestions are about the page on screen, which the Meta agent cannot read on a remote connection.
  const suggestions = useMemo(
    () => (hasConversation || snap.status === 'unsupported' || remoteView ? [] : visibleSuggestions(SPACES_SUGGESTIONS[view.kind], messages, layoutRules)),
    [hasConversation, messages, snap.status, view.kind, cardsVersion, layoutRules, remoteView], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startConversation = useCallback(async () => {
    if (!nodeId || busy || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartError(null);
    try {
      const next = await resetAssistant(nodeId);
      setTarget(null);
      setDraftRequest(null);
      adoptAssistantInfo(next);
      window.dispatchEvent(new CustomEvent(MICHI_ASSISTANT_RESET_EVENT, { detail: next }));
      controllerRef.current.focusInput();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Could not start a new conversation. Try again.');
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [nodeId, busy, setTarget]);

  const send = useCallback((text: string) => {
    if (!nodeId || !text.trim() || startingRef.current) return;
    setSubmittedNodeId(nodeId);
    requestAssistantSend(nodeId, text);
  }, [nodeId]);

  const blockDraftSequence = useRef(0);
  const respondToBlock = useCallback((next: MetaChatBlockTarget, prompt: string, sendNow: boolean) => {
    if (!active || !nodeId || snap.status === 'unsupported' || startingRef.current || (sendNow && busy) || !prompt.trim()) return false;
    // Turn context is read synchronously when a send starts, before React commits the target chip.
    contextRef.current = { ...contextRef.current, target: next };
    setTargetState({ key, target: next });
    controllerRef.current.focusInput();
    if (sendNow) send(prompt);
    else setDraftRequest({ id: --blockDraftSequence.current, text: prompt });
    return true;
  }, [active, nodeId, snap.status, busy, key, send]);
  const blockAssistantAvailable = active && !!nodeId && snap.status !== 'unsupported' && !starting;
  const targeting = useMemo(() => ({ target, setTarget, askAbout, respondToBlock: blockAssistantAvailable ? respondToBlock : undefined }), [target, setTarget, askAbout, respondToBlock, blockAssistantAvailable]);

  const conversation = !active ? null : snap.status === 'unsupported'
    ? <p className="meta-chat-panel__empty" role="status">This backend has no assistant.</p>
    : (
      <MetaChatDecorationsContext.Provider value={decorations}>
        <AssistantConversation links={links} question={question} onClickCapture={onFollowUpCapture}
          focusToken={controller.focusToken} draftRequest={draftRequest}
          disabled={starting}
          composerContext={<>
            {target && <span className="meta-chat-panel__target">Targeting: {target.title}<button type="button" aria-label="Clear target" onClick={() => setTarget(null)}><X size={11} aria-hidden /></button></span>}
            <MetaChatSuggestions suggestions={suggestions} busy={busy || starting} onSuggestion={suggestion => send(suggestion.label)} />
          </>} />
      </MetaChatDecorationsContext.Provider>
    );

  const notice = startError ? <p className="meta-chat-panel__notice" role="alert">{startError}</p> : guardFailed ? (
    <p className="meta-chat-panel__notice" role="alert">
      <span>The Meta agent&apos;s tool check failed.</span>
      <button type="button" onClick={requestMetaAgentSettings}>Open Settings › Meta agent</button>
    </p>
  ) : remoteView ? (
    <p className="meta-chat-panel__notice" data-tone="info" role="status">
      <span>{REMOTE_SPACES_NOTE}, so the Meta agent can&apos;t read {view.kind === 'workspace' ? view.name : 'this page'}.</span>
    </p>
  ) : null;

  return (
    <MetaChatTargetContext.Provider value={active ? targeting : null}>
      <div className="spaces-meta-host" hidden={!active}>
        <MetaChatArea
          controller={controller}
          visible={active}
          shortcut={false}
          pageName={pageName}
          busy={busy || starting}
          conversationKey={nodeId}
          submitDisabled={starting || !nodeId || snap.status !== 'ready'}
          onNewConversation={() => { void startConversation(); }}
          newConversationDisabled={busy || !nodeId || snap.status !== 'ready'}
          newConversationPending={starting}
          target={target ? { label: target.title } : null}
          onClearTarget={() => setTarget(null)}
          onSubmit={send}
          draftRequest={draftRequest}
          notice={notice}
          conversation={conversation}
          conversationComposer
        >
          {children}
        </MetaChatArea>
      </div>
    </MetaChatTargetContext.Provider>
  );
}

/** The same live chat and composer as Michi's conversations, with Spaces context supplied at send time. */
function AssistantConversation({ links, question = false, onClickCapture, focusToken, draftRequest, composerContext, disabled }: {
  links: MarkdownLinkRenderer;
  question?: boolean;
  onClickCapture?: (event: ReactMouseEvent<HTMLElement>) => void;
  focusToken: number;
  draftRequest: { id: number; text: string } | null;
  composerContext: ReactNode;
  disabled: boolean;
}) {
  const snap = useAssistantSnapshot();
  const { state: nodeState, retry } = useAssistantNode(snap.info);
  const nodeId = snap.info?.nodeId;
  if (snap.status === 'ready' && nodeState === 'ready' && nodeId) {
    return (
      <div className="meta-chat-conversation" data-question={question ? '' : undefined} onClickCapture={onClickCapture}>
        <AssistantLinkScope>
          <MarkdownLinkRendererContext.Provider value={links}>
            <TPane key={nodeId} nodeId={nodeId} embedded spacesAssistant composerFocusToken={focusToken} draftRequest={draftRequest}
              composerDisabled={disabled} composerPreBlocks={composerContext} />
          </MarkdownLinkRendererContext.Provider>
        </AssistantLinkScope>
      </div>
    );
  }
  if (snap.status === 'error' || nodeState === 'failed') {
    return (
      <p className="meta-chat-panel__empty" role="status">
        Couldn&apos;t reach the assistant.{' '}
        <button type="button" className="michi-doc-link-btn" onClick={() => { if (snap.status === 'error') void loadAssistant(); else retry(); }}>Retry</button>
      </p>
    );
  }
  return <p className="meta-chat-panel__empty" aria-busy="true">Loading the conversation…</p>;
}
