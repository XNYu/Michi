/**
 * Desk reads Michi threads (one row per conversation tree) and sorts them
 * into waiting / in progress / stalled / done / chatted.
 *
 * The rules use only what SQLite already stores: who spoke last, whether a
 * turn is still running, and how long the thread has been quiet. They do
 * not guess at plans, blockers, or git state.
 */

export const DESK_STALL_DAYS = 3;
export const DESK_SECTION_LIMIT = 8;
export const DESK_WINDOW_DAYS = 30;
export const DESK_DAY_MS = 24 * 60 * 60 * 1000;

export type DeskThreadState = 'waiting' | 'stalled' | 'doing' | 'done' | 'idea';

export type DeskMarkDisposition = 'active' | 'archived' | 'ignored';

export interface DeskSource {
  sessionId: string;
  messageId: string;
  provider: string;
  app: string;
  via?: 'Michi';
}

export interface DeskThread {
  id: string;
  projectId: string;
  projectTitle: string;
  rootNodeId: string;
  /** Node that holds the latest message. Opening the thread focuses this pane. */
  focusNodeId: string;
  title: string;
  state: DeskThreadState;
  doneBy?: 'user' | 'agent';
  lastActivityAt: number | null;
  idleDays: number;
  /** One line from the latest message. */
  stoppedAt: string;
  /** First suggested follow-up, when the thread stored one. */
  next: string | null;
  source: DeskSource | null;
  /** Archived on the Desk, then the thread moved again. */
  returned?: true;
  /** Hidden from the live sections because the Michi thread itself is archived. */
  michiArchived?: true;
  /** Desk archive, or a Michi-archived thread. Omitted on live threads. */
  archived?: true;
}

export interface DeskProject {
  id: string;
  title: string;
  isNew: boolean;
  dot: 'waiting' | 'stalled' | 'calm';
  waitingCount: number;
  lastActivityAt: number | null;
}

export interface DeskAgendaItem {
  time: string;
  title: string;
  allDay: boolean;
}

export interface DeskNow {
  since: number;
  summary: string | null;
  agenda: DeskAgendaItem[];
  waiting: DeskThread[];
  stalled: DeskThread[];
  done: DeskThread[];
  more: { waiting: number; stalled: number; done: number };
  archived: DeskThread[];
  archivedCount: number;
}

export interface DeskChangeCounts {
  waiting: number;
  stalled: number;
  doing: number;
  done: number;
}

export interface DeskProjectView {
  project: DeskProject;
  since: number;
  changes: DeskChangeCounts;
  next: DeskThread | null;
  threads: DeskThread[];
}

export interface DeskResume {
  app: string;
  command: string | null;
  cwd: string | null;
  shell: string | null;
  continuation: string;
  reason: null | 'no-session' | 'subagent' | 'unsupported' | 'bad-id' | 'cwd-missing';
  workspaceId?: string;
  treeId?: string;
  rootNodeId?: string;
  focusNodeId?: string;
}

export interface DeskPeekMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number | null;
}

export interface DeskPeek {
  thread: DeskThread;
  recent: DeskPeekMessage[];
}

export interface DeskReceipt {
  id: string;
  action: string;
}

export interface DeskWrite {
  receipt: DeskReceipt;
}

export interface DeskMark {
  disposition: DeskMarkDisposition;
  doneBy: 'user' | 'agent' | null;
  markedAt: number;
  /** lastActivityAt observed when the mark was written. */
  activityAtMark: number | null;
}

/** One thread's SQL facts, before a state is chosen. */
export interface DeskThreadFacts {
  id: string;
  projectId: string;
  projectTitle: string;
  rootNodeId: string;
  focusNodeId: string;
  title: string;
  lastActivityAt: number | null;
  lastRole: 'user' | 'assistant' | null;
  userMessages: number;
  assistantMessages: number;
  streaming: boolean;
  activeTurn: boolean;
  followUps: string[];
  stoppedAt: string;
  lastMessageId: string | null;
  treeArchivedAt: number | null;
  mark: DeskMark | null;
}

export interface ClassifiedDeskThread extends DeskThread {
  visibility: 'live' | 'archived' | 'hidden';
}

export function deskIdleDays(lastActivityAt: number | null, now: number): number {
  if (lastActivityAt == null) return 0;
  return Math.max(0, Math.floor((now - lastActivityAt) / DESK_DAY_MS));
}

export function isWithinDeskWindow(lastActivityAt: number | null, now: number): boolean {
  if (lastActivityAt == null) return false;
  return now - lastActivityAt <= DESK_WINDOW_DAYS * DESK_DAY_MS;
}

function activityAfter(lastActivityAt: number | null, activityAtMark: number | null): boolean {
  if (lastActivityAt == null) return false;
  if (activityAtMark == null) return true;
  return lastActivityAt > activityAtMark;
}

function baseState(facts: DeskThreadFacts, now: number): DeskThreadState {
  if (facts.streaming || facts.activeTurn) return 'doing';
  const quiet = deskIdleDays(facts.lastActivityAt, now) >= DESK_STALL_DAYS;
  const spoke = facts.userMessages > 0 || facts.assistantMessages > 0;
  // A thread nobody has typed in yet stays "chatted" and never becomes stalled.
  if (!spoke) return 'idea';
  if (facts.assistantMessages === 0) return quiet ? 'stalled' : 'doing';
  if (facts.lastRole === 'user') return quiet ? 'stalled' : 'doing';
  return quiet ? 'stalled' : 'waiting';
}

export function classifyDeskThread(facts: DeskThreadFacts, now: number): ClassifiedDeskThread {
  const idleDays = deskIdleDays(facts.lastActivityAt, now);
  let state = baseState(facts, now);
  const mark = facts.mark;
  const doneHeld = !!mark?.doneBy && !activityAfter(facts.lastActivityAt, mark.activityAtMark);
  if (doneHeld && state !== 'doing') state = 'done';

  const treeReturned = facts.treeArchivedAt != null && activityAfter(facts.lastActivityAt, facts.treeArchivedAt);
  const markReturned = !!mark && mark.disposition !== 'active' && activityAfter(facts.lastActivityAt, mark.activityAtMark);
  const returned = treeReturned || markReturned;

  let visibility: ClassifiedDeskThread['visibility'] = 'live';
  if (mark?.disposition === 'ignored' && !markReturned) visibility = 'hidden';
  else if ((facts.treeArchivedAt != null && !treeReturned) || (mark?.disposition === 'archived' && !markReturned)) {
    visibility = 'archived';
  }

  const followUp = facts.followUps.find((line) => line.trim().length > 0) ?? null;
  const thread: ClassifiedDeskThread = {
    id: facts.id,
    projectId: facts.projectId,
    projectTitle: facts.projectTitle,
    rootNodeId: facts.rootNodeId,
    focusNodeId: facts.focusNodeId || facts.rootNodeId,
    title: facts.title.trim() || 'Untitled',
    state,
    lastActivityAt: facts.lastActivityAt,
    idleDays,
    stoppedAt: facts.stoppedAt,
    next: followUp ? followUp.trim() : null,
    source: facts.rootNodeId
      ? {
          sessionId: facts.rootNodeId,
          messageId: facts.lastMessageId || facts.rootNodeId,
          provider: 'michi',
          app: 'Michi',
          via: 'Michi',
        }
      : null,
    visibility,
  };
  if (doneHeld && mark?.doneBy) thread.doneBy = mark.doneBy;
  if (returned && visibility === 'live') thread.returned = true;
  if (facts.treeArchivedAt != null) thread.michiArchived = true;
  if (visibility === 'archived') thread.archived = true;
  return thread;
}

function byRecent(a: DeskThread, b: DeskThread): number {
  return (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1);
}

function takeSection(threads: readonly ClassifiedDeskThread[], limit: number): { items: DeskThread[]; more: number } {
  const sorted = [...threads].sort(byRecent);
  return { items: sorted.slice(0, limit).map(stripVisibility), more: Math.max(0, sorted.length - limit) };
}

export function visibleDeskThreads(threads: readonly ClassifiedDeskThread[]): DeskThread[] {
  return threads.filter((thread) => thread.visibility !== 'hidden').map(stripVisibility);
}

function stripVisibility(thread: ClassifiedDeskThread): DeskThread {
  const { visibility: _visibility, ...rest } = thread;
  return rest;
}

export function buildDeskSummary(input: {
  since: number;
  waiting: readonly DeskThread[];
  stalled: readonly DeskThread[];
  done: readonly DeskThread[];
}): string {
  const parts: string[] = [];
  if (input.waiting.length === 1) parts.push('1 waiting on you');
  else if (input.waiting.length > 1) parts.push(`${input.waiting.length} waiting on you`);

  if (input.stalled.length === 1) {
    const days = input.stalled[0].idleDays;
    parts.push(days > 0 ? `1 line stalled for ${days} ${days === 1 ? 'day' : 'days'}` : '1 line stalled');
  } else if (input.stalled.length > 1) {
    const longest = input.stalled.reduce((max, thread) => Math.max(max, thread.idleDays), 0);
    parts.push(
      longest > 0
        ? `${input.stalled.length} lines stalled, the longest for ${longest} ${longest === 1 ? 'day' : 'days'}`
        : `${input.stalled.length} lines stalled`,
    );
  }

  const finished = input.since > 0
    ? input.done.filter((thread) => (thread.lastActivityAt ?? 0) > input.since)
    : [];
  if (finished.length === 1) parts.push('1 just finished');
  else if (finished.length > 1) parts.push(`${finished.length} just finished`);

  if (parts.length === 0) return 'Nothing is waiting.';
  return `${parts.join('. ')}.`;
}

export function assembleDeskNow(
  threads: readonly ClassifiedDeskThread[],
  since: number,
  now: number,
  limit = DESK_SECTION_LIMIT,
): DeskNow {
  const live = (state: DeskThreadState) => threads.filter((thread) => (
    thread.visibility === 'live'
    && thread.state === state
    && isWithinDeskWindow(thread.lastActivityAt, now)
  ));
  const waitingAll = live('waiting');
  const stalledAll = live('stalled');
  const doneAll = live('done');
  const waiting = takeSection(waitingAll, limit);
  const stalled = takeSection(stalledAll, limit);
  const done = takeSection(doneAll, limit);
  const archived = threads.filter((thread) => thread.visibility === 'archived').sort(byRecent);
  return {
    since,
    summary: buildDeskSummary({ since, waiting: waitingAll, stalled: stalledAll, done: doneAll }),
    agenda: [],
    waiting: waiting.items,
    stalled: stalled.items,
    done: done.items,
    more: { waiting: waiting.more, stalled: stalled.more, done: done.more },
    archived: archived.slice(0, limit).map(stripVisibility),
    archivedCount: archived.length,
  };
}

function liveInWindow(threads: readonly ClassifiedDeskThread[], now: number): ClassifiedDeskThread[] {
  return threads.filter((thread) => thread.visibility === 'live' && isWithinDeskWindow(thread.lastActivityAt, now));
}

export function assembleDeskProjects(threads: readonly ClassifiedDeskThread[], now: number): DeskProject[] {
  const byProject = new Map<string, ClassifiedDeskThread[]>();
  for (const thread of threads) {
    if (thread.visibility === 'hidden') continue;
    const list = byProject.get(thread.projectId) ?? [];
    list.push(thread);
    byProject.set(thread.projectId, list);
  }
  const projects: DeskProject[] = [];
  for (const [id, group] of byProject) {
    const windowed = liveInWindow(group, now);
    const waitingCount = windowed.filter((thread) => thread.state === 'waiting').length;
    const stalledCount = windowed.filter((thread) => thread.state === 'stalled').length;
    const lastActivityAt = group.reduce<number | null>((max, thread) => {
      if (thread.lastActivityAt == null) return max;
      if (max == null || thread.lastActivityAt > max) return thread.lastActivityAt;
      return max;
    }, null);
    projects.push({
      id,
      title: group[0]?.projectTitle || 'Untitled',
      isNew: false,
      dot: waitingCount > 0 ? 'waiting' : stalledCount > 0 ? 'stalled' : 'calm',
      waitingCount,
      lastActivityAt,
    });
  }
  const rank = { waiting: 0, stalled: 1, calm: 2 };
  projects.sort((a, b) => rank[a.dot] - rank[b.dot] || (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1) || a.title.localeCompare(b.title));
  return projects;
}

export function assembleDeskProject(
  threads: readonly ClassifiedDeskThread[],
  projectId: string,
  since: number,
  now: number,
): DeskProjectView | null {
  const group = threads.filter((thread) => thread.projectId === projectId && thread.visibility !== 'hidden');
  if (group.length === 0) return null;
  const [project] = assembleDeskProjects(group, now);
  const visible = group.map(stripVisibility).sort(byRecent);
  const changed = group.filter((thread) => (
    thread.visibility === 'live'
    && since > 0
    && thread.lastActivityAt != null
    && thread.lastActivityAt > since
  ));
  const changes: DeskChangeCounts = { waiting: 0, stalled: 0, doing: 0, done: 0 };
  for (const thread of changed) {
    if (thread.state === 'idea') continue;
    changes[thread.state] += 1;
  }
  const next = visible.find((thread) => !thread.archived && thread.state === 'waiting')
    ?? visible.find((thread) => !thread.archived && thread.state === 'stalled')
    ?? visible.find((thread) => !thread.archived && thread.state === 'doing')
    ?? null;
  return { project, since, changes, next, threads: visible };
}

export function deskContinuation(thread: Pick<DeskThread, 'next' | 'stoppedAt' | 'title'>): string {
  return thread.next || thread.stoppedAt || thread.title;
}
