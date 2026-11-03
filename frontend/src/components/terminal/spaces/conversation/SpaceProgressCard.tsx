import React from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig, type Variants } from 'motion/react';
import { Check, ChevronRight, CircleAlert, CircleStop, Hand, MessageSquare } from 'lucide-react';
import type { ProgressCardAwaiting, ProgressCardDto, ProgressCardStatus } from 'michi-shared';
import { useChatProjects, useNodesSelector } from '../../../../state/chatStore';
import type { ChatNodeState } from '../../../../state/chatTypes';
import { cardLiveState, replySummary } from '../../../../state/spaceConversations/liveStatus';
import { Button } from '../../../ui/controls';
import { homeAge } from '../home/homeFormat';
import { EASE, SPRING, TRANSITION } from '../../../../motion/tokens';
import '../../content/michi.css';

interface LiveView {
  status: ProgressCardStatus;
  line: string;
  title: string;
  runtimeId: string | null;
  summary: string | null;
  awaiting: ProgressCardAwaiting | null;
  waitingFor: string | null;
}

const sameView = (a: LiveView, b: LiveView) =>
  a.status === b.status && a.line === b.line && a.title === b.title && a.runtimeId === b.runtimeId && a.summary === b.summary
  && a.awaiting === b.awaiting && a.waitingFor === b.waitingFor;

const STATUS_WORD: Record<ProgressCardStatus, string> = {
  idle: 'Not started',
  running: '',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped',
};

const WAITING: Record<ProgressCardAwaiting, { action: string; known: (detail: string) => string; unknown: string }> = {
  approval: { action: 'Open chat to approve', known: (detail) => `Needs your approval for “${detail}”`, unknown: 'Needs your approval to go on.' },
  question: { action: 'Open chat to answer', known: (detail) => `Asks you: “${detail}”`, unknown: 'Asked you a question.' },
};

function runtimeName(runtimeId: string, runtimes: ReadonlyArray<{ id: string; label?: string }> | undefined): string {
  const label = runtimes?.find((runtime) => runtime.id === runtimeId)?.label;
  return label || runtimeId.charAt(0).toUpperCase() + runtimeId.slice(1);
}

/** What a finished card says: the reply's conclusion when it is done, else how it ended. */
function endText(view: LiveView, error: string | null | undefined): string {
  if (view.status === 'failed') return error ? `Stopped with an error: ${error}` : 'Stopped with an error.';
  if (view.status === 'cancelled') return 'Stopped before it finished.';
  return view.summary || 'Finished without a reply.';
}

type IconKind = 'waiting' | 'running' | 'done' | 'stopped' | 'failed';
const iconKind = (view: LiveView): IconKind => (view.awaiting ? 'waiting'
  : view.status === 'running' || view.status === 'idle' ? 'running'
    : view.status === 'done' ? 'done' : view.status === 'cancelled' ? 'stopped' : 'failed');

function Icon({ kind }: { kind: IconKind }) {
  if (kind === 'waiting') return <Hand size={14} strokeWidth={1.8} className="space-live-card__waiting" aria-label="Waiting for you" />;
  if (kind === 'running') return <span className="agent-spinner" role="img" aria-label="Running" />;
  if (kind === 'done') return <Check size={14} strokeWidth={2} className="space-live-card__done" aria-label="Done" />;
  if (kind === 'stopped') return <CircleStop size={14} strokeWidth={1.8} className="space-live-card__stopped" aria-label="Stopped" />;
  return <CircleAlert size={14} strokeWidth={1.8} className="space-live-card__failed" aria-label="Failed" />;
}

const ICON_STAGE: React.CSSProperties = { display: 'inline-grid', flexShrink: 0 };
const ICON_LAYER: React.CSSProperties = { gridArea: '1 / 1', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };

function IconLayer({ kind }: { kind: IconKind }) {
  // The glyph on its way out is not read out alongside the new one.
  const present = useIsPresent();
  return (
    <motion.span style={ICON_LAYER} initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.6, opacity: 0, transition: TRANSITION.exit }} transition={SPRING.snappy} aria-hidden={present ? undefined : true}>
      <Icon kind={kind} />
    </motion.span>
  );
}

/** How the conversation is doing; a new state (running → done ✓, stopped) scales in over the last. Drawn settled at first. */
function StatusIcon({ view }: { view: LiveView }) {
  const kind = iconKind(view);
  return (
    <span style={ICON_STAGE}>
      <AnimatePresence initial={false}>
        <IconLayer key={kind} kind={kind} />
      </AnimatePresence>
    </span>
  );
}

/** The gap an element sits in beside a sibling (its parent's row gap, whatever the CSS says now). */
const rowGapOf = (el: Element | null) => {
  const parent = el?.parentElement;
  return parent && parent.children.length > 1 ? parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
};

export interface FoldCustom { still: boolean; el: () => Element | null }

/**
 * How a card, or the list with its last card, folds away when the list lets
 * it go: height, padding and opacity over 140ms, taking the gap it sat in
 * along. Back before it is gone (a dismissal Michi refused), it opens again.
 * Under reduced motion only the fade.
 */
export const FOLD: Variants = {
  shown: { height: 'auto', opacity: 1, marginBottom: 0 },
  gone: ({ still, el }: FoldCustom) => (still
    ? { opacity: 0, transition: { duration: 0.14 } }
    : {
      height: 0, paddingTop: 0, paddingBottom: 0, borderTopWidth: 0, borderBottomWidth: 0, opacity: 0,
      marginBottom: -rowGapOf(el()), overflow: 'hidden', transition: { duration: 0.14, ease: EASE.drawer },
    }),
};

/**
 * One conversation started from a Space. Shows only how it is doing, read
 * from the thread: what it waits for while it runs, and once it ends how it
 * ended and what its reply concluded.
 */
export function SpaceProgressCard({ card, clock, onOpen, onDismiss }: {
  card: ProgressCardDto;
  clock: number;
  /** `pending`: open at the request it waits on, so the person can answer it there. */
  onOpen(card: ProgressCardDto, options: { continueChat: boolean; pending?: ProgressCardAwaiting }): void;
  onDismiss?(card: ProgressCardDto): void;
}) {
  const { agentStatus } = useChatProjects();
  const view = useNodesSelector(
    React.useCallback((nodes: Record<string, ChatNodeState>): LiveView => {
      const node = nodes[card.threadNodeId];
      const live = cardLiveState(card, node);
      const finished = live.status !== 'running' && live.status !== 'idle';
      return { ...live, summary: finished ? card.summary ?? (node ? replySummary(node) : null) : null };
    }, [card]),
    sameView,
  );
  const running = view.status === 'running';
  const inProgress = running || view.status === 'idle';
  const cardRef = React.useRef<HTMLElement>(null);
  // In its list's AnimatePresence: folding away it is out of reach and inert.
  const present = useIsPresent();
  const still = useReducedMotionConfig() === true;
  const dismiss = onDismiss && (
    <Button variant="ghost" size="sm" className="space-live-card__dismiss" aria-label={`Dismiss “${view.title}”`} onClick={() => onDismiss(card)}>Dismiss</Button>
  );
  const open = (continueChat: boolean) => onOpen(card, { continueChat });
  // A finished card counts from when it finished ("Done · 5m ago"); one not started yet, from when it was asked for.
  const meta = [card.workspaceName, running ? view.line : STATUS_WORD[view.status], running ? null : homeAge(card.finishedAt ?? card.createdAt, clock)]
    .filter(Boolean).join(' · ');
  const waiting = view.awaiting ? WAITING[view.awaiting] : null;

  return (
    <motion.article ref={cardRef} className="space-live-card" data-status={view.status} data-awaiting={view.awaiting ?? undefined} aria-label={`Chat: ${view.title}`}
      custom={{ still, el: () => cardRef.current } satisfies FoldCustom} variants={FOLD} initial={false} animate="shown" exit="gone"
      aria-hidden={present ? undefined : true} inert={!present}>
      <header className="space-live-card__head">
        <StatusIcon view={view} />
        <button type="button" className="space-live-card__title" title={view.title} onClick={() => open(false)}>{view.title}</button>
        {view.runtimeId && <span className="michi-tag" data-variant="archived">{runtimeName(view.runtimeId, agentStatus?.availableRuntimes)}</span>}
        <span className="space-live-card__meta" role={running ? 'status' : undefined}>{meta}</span>
        <button type="button" className="space-live-card__open" onClick={() => open(false)}>
          Open full chat<ChevronRight size={12} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </header>
      {waiting && view.awaiting ? <>
        <p className="space-live-card__text">{view.waitingFor ? waiting.known(view.waitingFor) : waiting.unknown}</p>
        <div className="space-live-card__row">
          <Button size="sm" onClick={() => onOpen(card, { continueChat: false, pending: view.awaiting! })}>{waiting.action}</Button>
          <span className="space-live-card__meta">You answer it in the chat</span>
          {dismiss}
        </div>
      </> : inProgress ? (
        <div className="space-live-card__row">
          <p className="space-live-card__text">Every step shows on the chat page.</p>
          {dismiss}
        </div>
      ) : <>
        <p className="space-live-card__text">{endText(view, card.error)}</p>
        <div className="space-live-card__row">
          <Button size="sm" onClick={() => open(true)}>
            <MessageSquare size={12} strokeWidth={1.7} aria-hidden="true" />Continue chatting
          </Button>
          <span className="space-live-card__meta">Opens the chat page</span>
          {dismiss}
        </div>
      </>}
    </motion.article>
  );
}
