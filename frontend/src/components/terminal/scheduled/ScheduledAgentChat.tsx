import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sparkles } from 'lucide-react';
import { META_AGENT_GUARD_ERROR_CODE } from 'michi-shared';
import TPane from '../TPane';
import { AssistantLinkChip, AssistantLinkScope } from '../assistant/AssistantLinks';
import { MarkdownLinkRendererContext, type MarkdownLinkRenderer } from '../../markdownLinkRenderer';
import { useChatProjects, useStructuralSelector } from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import { parseAssistantLink } from '../../../state/assistant/assistantLinks';
import { setAssistantShownElsewhere } from '../../../state/assistant/assistantStore';
import { useAssistantNode } from '../../../state/assistant/useAssistantNode';
import {
  adoptScheduleAssistantInfo,
  getScheduleAssistantSnapshot,
  loadScheduleAssistant,
  scheduleAssistantSource,
  subscribeScheduleAssistantOpen,
  takeScheduleAssistantOpenRequest,
  useScheduleAssistant,
} from '../../../state/assistant/scheduleAssistantStore';
import {
  AssistantApiError,
  fetchScheduleAssistant,
  provideMetaAgentTurnContext,
  resetScheduleAssistant,
  type AssistantInfo,
} from '../../../services/api/assistant';
import { useMetaChatWindow, type MetaChatWindowController } from '../../../state/metaChat/useMetaChatWindow';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../../state/metaChat/metaChatDecorations';
import { metaAgentToolLine } from '../../../state/metaChat/toolLines';
import { MetaChatArea } from '../spaces/metaChat/MetaChatArea';
import { requestMetaAgentSettings } from './metaAgent/metaAgentNav';

export const SCHEDULED_AGENT_WINDOW_KEY = 'michi:scheduled-agent-window';
export const CREATE_WITH_AGENT_LABEL = 'Create with agent';
/** Below this width (the shell's narrow mode) the window opens full screen: a floating box does not fit. */
const NARROW_WIDTH = 700;

/**
 * The Scheduled page with its "Create with agent" window: the Meta agent's
 * window (floating, docked, full screen or minimized to a labelled button),
 * showing the assistant's Scheduled conversation. Each message tells the
 * agent which workspace a new job goes in by default (the one New job
 * preselects); the agent creates jobs through its own tools, each approved by
 * the user, and the list below picks them up from the job-change events.
 */
export function ScheduledAgentChat({ enabled, defaultWorkspaceId, children }: {
  /** False while the page cannot schedule (no scheduler, no local workspace): no button, the page as it is. */
  enabled: boolean;
  defaultWorkspaceId: string | null;
  children: ReactNode;
}) {
  const controller = useMetaChatWindow({ storageKey: SCHEDULED_AGENT_WINDOW_KEY, initialState: { minimized: true } });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const snap = useScheduleAssistant();
  const info = snap.info;
  const nodeId = info?.nodeId ?? null;
  const visible = enabled && snap.status !== 'unsupported';

  useEffect(() => {
    if (enabled) void loadScheduleAssistant();
  }, [enabled]);

  // A notification or the "agent is asking" bar for this conversation opens the window.
  useEffect(() => {
    const consume = () => { if (takeScheduleAssistantOpenRequest()) controllerRef.current.focusInput(); };
    consume();
    return subscribeScheduleAssistantOpen(consume);
  }, []);

  const opening = useMemo<MetaChatWindowController>(() => ({
    ...controller,
    restore: () => {
      if (window.innerWidth < NARROW_WIDTH && !controller.fullscreen) controller.toggleFullscreen();
      else controller.restore();
    },
  }), [controller]);

  // Each message carries the workspace a new job goes in unless the user names another.
  const workspaceRef = useRef(defaultWorkspaceId);
  workspaceRef.current = defaultWorkspaceId;
  useEffect(() => {
    if (!visible || !nodeId) return undefined;
    return provideMetaAgentTurnContext(nodeId, () => ({ schedule: { workspaceId: workspaceRef.current || null } }));
  }, [visible, nodeId]);

  // While the window shows the conversation, its replies and questions are in view.
  const shown = visible && !controller.state.minimized;
  useEffect(() => {
    if (!shown || !nodeId) return undefined;
    setAssistantShownElsewhere(nodeId, true);
    return () => setAssistantShownElsewhere(nodeId, false);
  }, [nodeId, shown]);

  // The conversation loads the first time the window opens, and stays mounted for its draft.
  const [opened, setOpened] = useState(shown);
  if (shown && !opened) setOpened(true);

  const status = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => (nodeId ? nodes[nodeId]?.status : undefined),
    [nodeId],
  ));
  const errorKind = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => (nodeId ? nodes[nodeId]?.errorKind : undefined),
    [nodeId],
  ));
  const busy = status === 'streaming';
  const guardFailed = status === 'error' && errorKind === META_AGENT_GUARD_ERROR_CODE;

  // After each turn: a runtime switch the turn made is in the conversation's info.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ended = wasBusy.current && !busy;
    wasBusy.current = busy;
    if (!ended) return;
    const expected = getScheduleAssistantSnapshot().info?.nodeId;
    fetchScheduleAssistant().then((next) => {
      if (getScheduleAssistantSnapshot().info?.nodeId === expected) adoptScheduleAssistantInfo(next);
    }, () => {});
  }, [busy]);

  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startConversation = useCallback(async () => {
    if (!nodeId || busy || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setStartError(null);
    try {
      adoptScheduleAssistantInfo(await resetScheduleAssistant(nodeId));
      controllerRef.current.focusInput();
    } catch (error) {
      // Another window already started over: show the conversation that is current now.
      if (error instanceof AssistantApiError && error.current) adoptScheduleAssistantInfo(error.current);
      else setStartError(error instanceof Error ? error.message : 'Could not start a new conversation. Try again.');
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [nodeId, busy]);

  const { projects, agentStatus } = useChatProjects();
  const runtimeName = useCallback(
    (runtimeId: string) => agentStatus?.availableRuntimes?.find((runtime) => runtime.id === runtimeId)?.label || runtimeId,
    [agentStatus?.availableRuntimes],
  );
  const switches = info?.runtimeSwitches;
  const decorations = useMemo<MetaChatDecorations>(() => {
    const names = {
      workspace: (id: string) => projects.find((project) => project.id === id && !project.system)?.name ?? null,
      page: () => null,
    };
    const byMessage = new Map((switches ?? []).map((change) => [change.afterMessageId, change]));
    return {
      assistantLabel: <span className="meta-chat-speaker"><Sparkles size={11} aria-hidden /> Michi</span>,
      toolLine: (tool) => metaAgentToolLine(tool, names),
      afterMessage: (message) => {
        const change = byMessage.get(message.id);
        return change
          ? <div className="meta-chat-runtime-switch" role="separator" aria-label={`From here on: ${runtimeName(change.runtimeId)}`}><span>From here on: {runtimeName(change.runtimeId)}</span></div>
          : null;
      },
    };
  }, [projects, runtimeName, switches]);

  const notice = startError ? <p className="meta-chat-panel__notice" role="alert">{startError}</p> : guardFailed ? (
    <p className="meta-chat-panel__notice" role="alert">
      <span>The Meta agent&apos;s tool check failed.</span>
      <button type="button" onClick={requestMetaAgentSettings}>Open Settings › Meta agent</button>
    </p>
  ) : null;

  const conversation = visible && opened ? (
    <MetaChatDecorationsContext.Provider value={decorations}>
      <ScheduledConversation info={info} status={snap.status} focusToken={controller.focusToken} disabled={starting} />
    </MetaChatDecorationsContext.Provider>
  ) : null;

  return (
    <MetaChatArea
      controller={opening}
      visible={visible}
      shortcut={false}
      pillLabel={CREATE_WITH_AGENT_LABEL}
      firstRunDot={false}
      pageName="Scheduled"
      busy={busy || starting}
      conversationKey={nodeId}
      onNewConversation={() => { void startConversation(); }}
      newConversationDisabled={busy || !nodeId || snap.status !== 'ready'}
      newConversationPending={starting}
      notice={notice}
      conversation={conversation ?? <p className="meta-chat-panel__empty">Describe a job: what to do, where, and when.</p>}
      conversationComposer
    >
      {children}
    </MetaChatArea>
  );
}

const links: MarkdownLinkRenderer = {
  protocols: ['michi'],
  matches: (href) => parseAssistantLink(href) !== null,
  render: (href, children) => {
    const link = parseAssistantLink(href);
    return link ? <AssistantLinkChip link={link}>{children}</AssistantLinkChip> : children;
  },
};

/** The same live chat and composer as Michi's conversations, with the Scheduled context supplied at send time. */
function ScheduledConversation({ info, status, focusToken, disabled }: {
  info: AssistantInfo | null;
  status: ReturnType<typeof getScheduleAssistantSnapshot>['status'];
  focusToken: number;
  disabled: boolean;
}) {
  const { state: nodeState, retry } = useAssistantNode(info);
  const source = useMemo(() => scheduleAssistantSource(info), [info]);
  if (status === 'ready' && nodeState === 'ready' && info) {
    return (
      <div className="meta-chat-conversation">
        <AssistantLinkScope>
          <MarkdownLinkRendererContext.Provider value={links}>
            <TPane key={info.nodeId} nodeId={info.nodeId} embedded spacesAssistant assistantSource={source}
              composerFocusToken={focusToken} composerDisabled={disabled} />
          </MarkdownLinkRendererContext.Provider>
        </AssistantLinkScope>
      </div>
    );
  }
  if (status === 'error' || nodeState === 'failed') {
    return (
      <p className="meta-chat-panel__empty" role="status">
        Couldn&apos;t reach the assistant.{' '}
        <button type="button" className="michi-doc-link-btn" onClick={() => { if (status === 'error') void loadScheduleAssistant(); else retry(); }}>Retry</button>
      </p>
    );
  }
  return <p className="meta-chat-panel__empty" aria-busy="true">Loading the conversation…</p>;
}
