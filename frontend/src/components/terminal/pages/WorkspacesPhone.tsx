import React from 'react';
import { flushSync } from 'react-dom';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Server,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { BackendConnectionSummary } from '../../../config/backendConnections';
import type { PageId } from '../../../state/commands';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { useChatNode, useNodesSelector } from '../../../state/chatStore';
import { isVisibleConversationNode } from '../../../state/conversationVisibility';
import { nodeAwaiting, nodeWaitingFor, progressStatusLine, threadTitle } from '../../../state/spaceConversations/liveStatus';
import {
  buildWorkspaceRowContextMenu,
  type ContextMenuItem,
  type WorkspaceRowActionId,
  type WorkspaceRowActions,
} from '../../../lib/workspaceRowContextMenu';
import { remoteMachineName } from '../../WorkspaceLocation';
import { BottomSheet } from '../../ui/BottomSheet';
import { Button } from '../../ui/controls';
import { Dot } from '../primitives';
import { initialOf, workspaceAccent } from '../workspaceAccent';
import {
  EmptyState,
  formatRelative,
  Highlight,
  matchesWorkspaceQuery,
  matchingNodes,
  pathForQuery,
  type WorkspaceCardData,
} from './workspaceList';
import './WorkspacesPhone.css';

// The Workspaces page on a phone: one row per workspace that says what it is
// doing now (waiting on you, running, failed, or its latest thread), and an
// action sheet for everything the desktop row menu offers.

/** A workspace's conversations that wait on the user or run right now, by node id. */
export interface WorkspaceLive { waiting: string | null; running: string | null }

const NO_LIVE: WorkspaceLive = { waiting: null, running: null };

function newerTurn(nodes: Record<string, ChatNodeState>, current: string | null, candidate: string): string {
  if (!current) return candidate;
  return (nodes[candidate]?.streamingStartedAt ?? 0) > (nodes[current]?.streamingStartedAt ?? 0) ? candidate : current;
}

/** Per workspace, its newest conversation waiting on the user and its newest
 *  one running, from the conversations a person sees (no page helpers or
 *  maintenance runs). */
export function selectWorkspaceLive(nodes: Record<string, ChatNodeState>): Map<string, WorkspaceLive> {
  const live = new Map<string, WorkspaceLive>();
  for (const node of Object.values(nodes)) {
    if (node.deletedAt || !isVisibleConversationNode(node)) continue;
    const waiting = nodeAwaiting(node) !== null;
    // A visibly finished answer whose runtime is still cleaning up is not "running".
    const running = !waiting && node.status === 'streaming' && !node.visibleResponseComplete;
    if (!waiting && !running) continue;
    const entry = live.get(node.projectId) ?? { waiting: null, running: null };
    if (waiting) entry.waiting = newerTurn(nodes, entry.waiting, node.nodeId);
    else entry.running = newerTurn(nodes, entry.running, node.nodeId);
    live.set(node.projectId, entry);
  }
  return live;
}

function sameLive(a: Map<string, WorkspaceLive>, b: Map<string, WorkspaceLive>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, entry] of a) {
    const other = b.get(id);
    if (!other || other.waiting !== entry.waiting || other.running !== entry.running) return false;
  }
  return true;
}

type RowState = 'waiting' | 'running' | 'failed' | 'idle';

function rowState(card: WorkspaceCardData, live: WorkspaceLive): RowState {
  if (live.waiting) return 'waiting';
  if (live.running) return 'running';
  return card.failed ? 'failed' : 'idle';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Long press ────────────────────────────────────────────────────────────

const LONG_PRESS_MS = 500;
/** How far a finger may drift before the press counts as a scroll. */
const LONG_PRESS_SLOP = 10;
/** The click that ends a long press arrives within this window, if at all. */
const LONG_PRESS_CLICK_MS = 800;

/** Touch and pen hold to open; the mouse asks with its right button instead. */
function useLongPress(onLongPress: () => void) {
  const timer = React.useRef<number | null>(null);
  const origin = React.useRef<{ x: number; y: number } | null>(null);
  const firedAt = React.useRef(0);
  const callback = React.useRef(onLongPress);
  callback.current = onLongPress;

  const cancel = React.useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);
  React.useEffect(() => cancel, [cancel]);

  const handlers = React.useMemo(() => ({
    onPointerDown: (event: React.PointerEvent) => {
      firedAt.current = 0;
      if (event.pointerType === 'mouse' || event.isPrimary === false) return;
      cancel();
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        origin.current = null;
        firedAt.current = Date.now();
        callback.current();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = origin.current;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  }), [cancel]);

  /** True for the click that ends a long press, which must not also open the row. */
  const consumeClick = React.useCallback(() => {
    const fired = firedAt.current !== 0 && Date.now() - firedAt.current < LONG_PRESS_CLICK_MS;
    firedAt.current = 0;
    return fired;
  }, []);

  return { handlers, consumeClick };
}

// ── Rows ──────────────────────────────────────────────────────────────────

function WaitingLine({ nodeId }: { nodeId: string }) {
  const node = useChatNode(nodeId);
  if (!node) return null;
  const detail = nodeWaitingFor(node) ?? threadTitle(node);
  return (
    <>
      <i className="ws-phone__mark" data-tone="waiting" aria-hidden="true" />
      <span className="ws-phone__label" data-tone="waiting">
        {nodeAwaiting(node) === 'question' ? 'Needs your answer' : 'Needs approval'}
      </span>
      <span className="ws-phone__sep" aria-hidden="true">·</span>
      <span className="ws-phone__detail">{detail}</span>
    </>
  );
}

/** Subscribes to the one running conversation, so its line follows each tool call. */
function RunningLine({ nodeId }: { nodeId: string }) {
  const node = useChatNode(nodeId);
  if (!node) return null;
  return (
    <>
      <Dot color="var(--term-select, var(--term-accent))" size={7} pulse />
      <span className="ws-phone__label" data-tone="running">{progressStatusLine(node)}</span>
      <span className="ws-phone__sep" aria-hidden="true">·</span>
      <span className="ws-phone__detail">{threadTitle(node)}</span>
    </>
  );
}

function StatusLine({ card, live, query, archived }: { card: WorkspaceCardData; live: WorkspaceLive; query: string; archived: boolean }) {
  const matches = React.useMemo(() => matchingNodes(card.nodes, query), [card.nodes, query]);
  // While filtering, say why the workspace matched.
  const top = matches[0];
  if (top) {
    return (
      <>
        {top.kind === 'digest' && <i className="ws-phone__mark" data-tone="digest" aria-hidden="true" />}
        <span className="ws-phone__detail"><Highlight text={top.title} q={query} /></span>
        {matches.length > 1 && <span className="ws-phone__more-count">+{matches.length - 1}</span>}
      </>
    );
  }
  const latest = card.threads[0]?.title;
  if (!archived) {
    switch (rowState(card, live)) {
      case 'waiting': return <WaitingLine nodeId={live.waiting!} />;
      case 'running': return <RunningLine nodeId={live.running!} />;
      case 'failed':
        return (
          <>
            <Dot color="var(--term-danger)" size={7} />
            <span className="ws-phone__label" data-tone="failed">
              {card.failed!.outcomeUnknown ? 'Last turn unconfirmed' : 'Last turn failed'}
            </span>
            <span className="ws-phone__sep" aria-hidden="true">·</span>
            <span className="ws-phone__detail">{card.failed!.title}</span>
          </>
        );
      default: break;
    }
  }
  return latest
    ? <span className="ws-phone__detail">{latest}</span>
    : <span className="ws-phone__detail" data-quiet="">No threads yet</span>;
}

function MetaLine({ card, query, machine }: { card: WorkspaceCardData; query: string; machine: string | null }) {
  return (
    <span className="ws-phone__meta">
      <span className="ws-phone__path">
        {card.cwd ? <Highlight text={pathForQuery(card.cwd, query)} q={query} /> : 'quick chat · no folder'}
      </span>
      <span className="ws-phone__sep" aria-hidden="true">·</span>
      <span>{plural(card.threadCount, 'thread')}</span>
      {machine && (
        <>
          <span className="ws-phone__sep" aria-hidden="true">·</span>
          <span className="ws-phone__machine">
            <Server size={12} aria-hidden="true" />
            <Highlight text={machine} q={query} />
          </span>
        </>
      )}
    </span>
  );
}

function WorkspaceBadge({ card, size }: { card: WorkspaceCardData; size?: 'lg' }) {
  return (
    <span className="ws-phone__badge" data-size={size} aria-hidden="true" style={{ background: workspaceAccent(card.id) }}>
      {initialOf(card.name)}
    </span>
  );
}

function WorkspaceRow({
  card,
  live,
  query,
  machine,
  archived = false,
  onOpen,
  onMenu,
}: {
  card: WorkspaceCardData;
  live: WorkspaceLive;
  query: string;
  machine: string | null;
  archived?: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const press = useLongPress(onMenu);
  return (
    <li
      className="ws-phone__row"
      data-testid={`workspace-row-${card.id}`}
      data-current={card.active || undefined}
      data-archived={archived || undefined}
    >
      <button
        type="button"
        className="ws-phone__open"
        aria-current={card.active ? 'true' : undefined}
        onClick={() => { if (!press.consumeClick()) onOpen(); }}
        onContextMenu={(event) => { event.preventDefault(); onMenu(); }}
        {...press.handlers}
      >
        <WorkspaceBadge card={card} />
        <span className="ws-phone__text">
          <span className="ws-phone__line1">
            <span className="ws-phone__name"><Highlight text={card.name} q={query} /></span>
            {card.pinnedAt !== null && <span className="ws-phone__pin" role="img" aria-label="Pinned"><Pin size={13} aria-hidden="true" /></span>}
            <span className="ws-phone__age">{formatRelative(card.lastTs)}</span>
          </span>
          <span className="ws-phone__line2">
            <StatusLine card={card} live={live} query={query} archived={archived} />
          </span>
          <MetaLine card={card} query={query} machine={machine} />
        </span>
      </button>
      <button type="button" className="ws-phone__more" aria-label="More actions" onClick={onMenu}>
        <Ellipsis size={20} aria-hidden="true" />
      </button>
    </li>
  );
}

// ── Action sheet ──────────────────────────────────────────────────────────

type SheetView = 'actions' | 'rename' | 'delete';

const ACTION_GLYPHS: Record<WorkspaceRowActionId, LucideIcon> = {
  manage: ArrowUpRight,
  folder: FolderOpen,
  rename: Pencil,
  pin: Pin,
  unpin: PinOff,
  archive: Archive,
  unarchive: ArchiveRestore,
  delete: Trash2,
};

/** Rename and delete keep the sheet open on their own step; every other action ends it. */
const STAYS_OPEN = new Set<WorkspaceRowActionId | undefined>(['rename', 'delete']);
/** An archived workspace is not opened (Settings › Connections doesn't offer it
 *  either) or pinned; it can be renamed, unarchived or deleted. */
const ARCHIVED_HIDES = new Set<WorkspaceRowActionId | undefined>(['manage', 'folder', 'pin', 'unpin']);

const SHEET_TITLE_ID = 'workspace-sheet-title';

function deleteExplanation(card: WorkspaceCardData): string {
  const threads = card.threadCount === 0
    ? 'It has no threads.'
    : `Its ${plural(card.threadCount, 'thread')} ${card.threadCount === 1 ? 'moves' : 'move'} to Trash with it.`;
  const files = card.cwd ? ' Files in its folder stay on disk.' : '';
  return `${threads} You can restore it from Trash.${files}`;
}

export type PhoneWorkspaceActions = Omit<WorkspaceRowActions, 'beginInlineRename' | 'requestDelete'> & {
  restoreProject: (projectId: string) => void;
};

interface Props {
  /** Live workspaces, newest activity first. */
  cards: WorkspaceCardData[];
  archivedCards: WorkspaceCardData[];
  projects: Project[];
  connections: BackendConnectionSummary[];
  query: string;
  onQueryChange: (query: string) => void;
  onOpen: (projectId: string) => void;
  onNew: () => void;
  onNav: (page: PageId) => void;
  actions: PhoneWorkspaceActions;
  onRename: (projectId: string, name: string) => void;
}

export default function PhoneWorkspaces({
  cards,
  archivedCards,
  projects,
  connections,
  query,
  onQueryChange,
  onOpen,
  onNew,
  onNav,
  actions,
  onRename,
}: Props) {
  const live = useNodesSelector(selectWorkspaceLive, sameLive);
  const liveOf = (id: string) => live.get(id) ?? NO_LIVE;
  const [filter, setFilter] = React.useState<'running' | 'waiting' | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [sheet, setSheet] = React.useState<{ id: string; view: SheetView } | null>(null);
  const [draft, setDraft] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);
  const renameRef = React.useRef<HTMLInputElement>(null);
  const keepRef = React.useRef<HTMLButtonElement>(null);

  const trimmed = query.trim();
  const counts = { running: 0, waiting: 0 };
  for (const card of cards) {
    const state = rowState(card, liveOf(card.id));
    if (state === 'running' || state === 'waiting') counts[state] += 1;
  }
  const visible = cards.filter((card) =>
    matchesWorkspaceQuery(card, trimmed, connections)
    && (!filter || rowState(card, liveOf(card.id)) === filter));
  const pinned = visible
    .filter((card) => card.pinnedAt !== null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  const recent = visible.filter((card) => card.pinnedAt === null);
  const archived = archivedCards.filter((card) => matchesWorkspaceQuery(card, trimmed, connections));
  const matchedThreads = trimmed
    ? visible.reduce((sum, card) => sum + matchingNodes(card.nodes, trimmed).length, 0)
    : 0;

  const sheetCard = sheet
    ? cards.find((card) => card.id === sheet.id) ?? archivedCards.find((card) => card.id === sheet.id)
    : undefined;
  const sheetProject = sheet ? projects.find((project) => project.id === sheet.id && !project.deletedAt) : undefined;
  const closeSheet = React.useCallback(() => setSheet(null), []);
  // The workspace went away underneath the sheet (deleted elsewhere).
  React.useEffect(() => {
    if (sheet && (!sheetCard || !sheetProject)) setSheet(null);
  }, [sheet, sheetCard, sheetProject]);

  const machineOf = (card: WorkspaceCardData) => remoteMachineName(card.backendConnectionId, connections);
  const openSheet = (id: string) => setSheet({ id, view: 'actions' });

  const rowActions: WorkspaceRowActions = {
    ...actions,
    archiveProject: (id) => {
      const name = projects.find((project) => project.id === id)?.name ?? 'workspace';
      actions.archiveProject(id);
      toast(`Archived “${name}”`, { action: { label: 'Undo', onClick: () => actions.unarchiveProject(id) } });
    },
    // In the same tap that chose Rename, so iOS raises the keyboard for the field.
    beginInlineRename: (id) => {
      flushSync(() => {
        setDraft(projects.find((project) => project.id === id)?.name ?? '');
        setSheet({ id, view: 'rename' });
      });
      renameRef.current?.focus();
      renameRef.current?.select();
    },
    requestDelete: (id) => {
      flushSync(() => setSheet({ id, view: 'delete' }));
      keepRef.current?.focus();
    },
  };

  const runAction = (item: ContextMenuItem) => {
    if (item.disabled) return;
    if (!STAYS_OPEN.has(item.id)) closeSheet();
    item.onSelect();
  };

  const commitRename = () => {
    if (!sheetCard) return;
    const name = draft.trim();
    if (name && name !== sheetCard.name) onRename(sheetCard.id, name);
    closeSheet();
  };

  const confirmDelete = () => {
    if (!sheetCard) return;
    const { id, name } = sheetCard;
    actions.deleteProject(id);
    closeSheet();
    toast(`Moved “${name}” to Trash`, { action: { label: 'Undo', onClick: () => actions.restoreProject(id) } });
  };

  const renderRow = (card: WorkspaceCardData, isArchived = false) => (
    <WorkspaceRow
      key={card.id}
      card={card}
      live={liveOf(card.id)}
      query={trimmed}
      machine={machineOf(card)}
      archived={isArchived}
      // An archived workspace opens to what can be done with it.
      onOpen={isArchived ? () => openSheet(card.id) : () => onOpen(card.id)}
      onMenu={() => openSheet(card.id)}
    />
  );

  const emptyText = filter === 'waiting'
    ? 'Nothing needs you right now.'
    : filter === 'running'
      ? 'Nothing is running right now.'
      : `No workspaces match “${trimmed}”.`;

  return (
    <div className="ws-phone term-scrollbar">
      <header className="ws-phone__head">
        <h1 className="ws-phone__title">
          Workspaces <span className="ws-phone__count">{cards.length}</span>
        </h1>
        <Button className="ws-phone__new" onClick={onNew} aria-label="New workspace">
          <Plus size={16} aria-hidden="true" />
          New
        </Button>
      </header>

      {(counts.running > 0 || counts.waiting > 0 || filter) && (
        <div className="ws-phone__chips" role="group" aria-label="Show only">
          {(counts.running > 0 || filter === 'running') && (
            <button
              type="button"
              className="ws-phone__chip"
              data-tone="running"
              aria-pressed={filter === 'running'}
              onClick={() => setFilter((current) => (current === 'running' ? null : 'running'))}
            >
              <Dot color="var(--term-select, var(--term-accent))" size={7} pulse={counts.running > 0} />
              <b>{counts.running}</b> running
            </button>
          )}
          {(counts.waiting > 0 || filter === 'waiting') && (
            <button
              type="button"
              className="ws-phone__chip"
              data-tone="waiting"
              aria-pressed={filter === 'waiting'}
              onClick={() => setFilter((current) => (current === 'waiting' ? null : 'waiting'))}
            >
              <i className="ws-phone__mark" data-tone="waiting" aria-hidden="true" />
              <b>{counts.waiting}</b> needs you
            </button>
          )}
        </div>
      )}

      <label className="ws-phone__search">
        <Search size={18} aria-hidden="true" />
        <input
          ref={searchRef}
          type="search"
          aria-label="Filter workspaces"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          // The results are already on screen; Search just puts the keyboard away.
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
          placeholder="Search workspaces, paths, threads"
        />
        {query && (
          <button type="button" aria-label="Clear" onClick={() => { onQueryChange(''); searchRef.current?.focus(); }}>
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </label>

      {trimmed && visible.length > 0 && (
        <p className="ws-phone__note" role="status">
          {plural(visible.length, 'workspace')}
          {matchedThreads > 0 && ` · ${plural(matchedThreads, 'matching thread')}`}
        </p>
      )}

      {cards.length === 0 && archivedCards.length === 0 ? (
        <EmptyState onNew={onNew} />
      ) : (
        <>
          {pinned.length > 0 && (
            <section aria-labelledby="workspaces-pinned">
              <h2 className="ws-phone__section">
                <span id="workspaces-pinned">Pinned</span>
                <span className="ws-phone__section-count">{pinned.length}</span>
              </h2>
              <ul className="ws-phone__list">{pinned.map((card) => renderRow(card))}</ul>
            </section>
          )}
          {recent.length > 0 && (pinned.length > 0 ? (
            <section aria-labelledby="workspaces-recent">
              <h2 className="ws-phone__section">
                <span id="workspaces-recent">Recent</span>
                <span className="ws-phone__section-count">{recent.length}</span>
              </h2>
              <ul className="ws-phone__list">{recent.map((card) => renderRow(card))}</ul>
            </section>
          ) : (
            <ul className="ws-phone__list" data-flat="" aria-label="Workspaces">{recent.map((card) => renderRow(card))}</ul>
          ))}
          {visible.length === 0 && cards.length > 0 && <p className="ws-phone__empty">{emptyText}</p>}

          <nav className="ws-phone__foot" aria-label="More workspaces">
            {archivedCards.length > 0 && (
              <>
                <button
                  type="button"
                  className="ws-phone__link"
                  aria-expanded={showArchived}
                  onClick={() => setShowArchived((open) => !open)}
                >
                  <Archive size={16} aria-hidden="true" />
                  Archived workspaces
                  <span className="ws-phone__link-end">
                    {trimmed ? `${archived.length}/${archivedCards.length}` : archivedCards.length}
                    <ChevronDown size={15} aria-hidden="true" data-open={showArchived || undefined} className="ws-phone__chevron" />
                  </span>
                </button>
                {showArchived && archived.length > 0 && (
                  <ul className="ws-phone__list" aria-label="Archived workspaces">{archived.map((card) => renderRow(card, true))}</ul>
                )}
              </>
            )}
            <button type="button" className="ws-phone__link" onClick={() => onNav('trash')}>
              <Trash2 size={16} aria-hidden="true" />
              Trash
              <span className="ws-phone__link-end"><ChevronRight size={15} aria-hidden="true" /></span>
            </button>
          </nav>
        </>
      )}

      <BottomSheet open={!!(sheet && sheetCard && sheetProject)} onClose={closeSheet} labelledBy={SHEET_TITLE_ID}>
        {sheet && sheetCard && sheetProject && sheet.view === 'actions' && (
          <>
            <div className="ws-phone__sheet-head">
              <WorkspaceBadge card={sheetCard} size="lg" />
              <span className="ws-phone__text">
                <h2 className="ws-phone__sheet-name" id={SHEET_TITLE_ID}>{sheetCard.name}</h2>
                <MetaLine card={sheetCard} query="" machine={machineOf(sheetCard)} />
              </span>
            </div>
            {buildWorkspaceRowContextMenu({ project: sheetProject, actions: rowActions })
              .map((section) => ({
                items: sheetProject.archivedAt ? section.items.filter((item) => !ARCHIVED_HIDES.has(item.id)) : section.items,
              }))
              .filter((section) => section.items.length > 0)
              .map((section, index) => (
              <div className="ui-sheet__group" key={index}>
                {section.items.map((item) => {
                  const Glyph = item.id ? ACTION_GLYPHS[item.id] : null;
                  return (
                    <button
                      key={item.id ?? item.label}
                      type="button"
                      className="ui-sheet__action"
                      data-danger={item.danger || undefined}
                      disabled={item.disabled}
                      onClick={() => runAction(item)}
                    >
                      {Glyph && <Glyph size={20} aria-hidden="true" />}
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="ui-sheet__buttons" data-stacked="">
              <Button onClick={closeSheet}>Cancel</Button>
            </div>
          </>
        )}
        {sheet && sheetCard && sheet.view === 'rename' && (
          <form onSubmit={(event) => { event.preventDefault(); commitRename(); }}>
            <div className="ui-sheet__section">
              <h2 className="ui-sheet__title" id={SHEET_TITLE_ID}>Rename workspace</h2>
              <input
                ref={renameRef}
                className="ws-phone__field"
                aria-label="Workspace name"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                enterKeyHint="done"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
              {sheetCard.cwd && (
                <p className="ws-phone__field-note">Only its name in Michi changes; the folder stays where it is.</p>
              )}
            </div>
            <div className="ui-sheet__buttons">
              <Button onClick={closeSheet}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!draft.trim()}>Save</Button>
            </div>
          </form>
        )}
        {sheet && sheetCard && sheet.view === 'delete' && (
          <>
            <div className="ui-sheet__section">
              <span className="ws-phone__danger-icon" aria-hidden="true"><Trash2 size={22} /></span>
              <h2 className="ui-sheet__title" id={SHEET_TITLE_ID}>Delete “{sheetCard.name}”?</h2>
              <p className="ui-sheet__body">{deleteExplanation(sheetCard)}</p>
            </div>
            <div className="ui-sheet__buttons" data-stacked="">
              <Button variant="primary" danger onClick={confirmDelete}>Delete workspace</Button>
              <Button ref={keepRef} onClick={closeSheet}>Cancel</Button>
            </div>
          </>
        )}
      </BottomSheet>
    </div>
  );
}
