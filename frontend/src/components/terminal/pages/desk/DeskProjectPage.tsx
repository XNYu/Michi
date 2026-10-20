import React, { useCallback, useEffect, useState } from 'react';
import type { DeskProjectView, DeskThread } from 'michi-shared';
import type { PageId } from '../../../../state/commands';
import { useChatStore } from '../../../../state/chatStore';
import { useDeskProject } from '../../../../state/deskRoute';
import { getDeskProject, markDeskProjectLooked } from '../../../../services/api/desk';
import {
  DeskScroll,
  DeskStatus,
  DeskThreadRow,
  DeskUndoBar,
  SectionHeading,
} from './DeskChrome';
import { StatusMark } from './StatusMark';
import { openDeskThread } from './openDeskThread';
import { useDeskActions } from './useDeskActions';

export default function DeskProjectPage({ onNav }: { onNav: (page: PageId) => void }) {
  const target = useDeskProject();
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState<DeskProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(target));
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((value) => value + 1), []);
  const { act } = useDeskActions(refresh);
  const navigation = useChatStore();

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    getDeskProject(target.id, controller.signal)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setError(null);
        setNow(Date.now());
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError('Couldn’t load this workspace.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    const openedAt = Date.now();
    const projectId = target.id;
    return () => {
      cancelled = true;
      controller.abort();
      if (Date.now() - openedAt > 800) void markDeskProjectLooked(projectId).catch(() => {});
    };
  }, [target?.id, reloadKey]);

  const continueThread = (thread: DeskThread) => openDeskThread(navigation, thread, onNav);

  if (!target) {
    return (
      <DeskScroll label="Workspace">
        <p style={{ color: 'var(--term-muted)' }}>Open a workspace from Desk.</p>
        <button type="button" onClick={() => onNav('desk')} style={linkButton}>Back to Desk</button>
      </DeskScroll>
    );
  }

  const counts = view ? countLive(view.threads) : null;
  const showChanges = !!view && view.since > 0;

  return (
    <DeskScroll label={target.title}>
      <div style={{ fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps-wide)', color: 'var(--term-muted)' }}>Workspace</div>
      <h1 style={{ fontSize: 'var(--fs-4xl)', fontWeight: 560, margin: '8px 0 4px' }}>{view?.project.title ?? target.title}</h1>
      {view && (
        <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', fontFamily: 'var(--font-mono)' }}>
          {view.threads.length} {view.threads.length === 1 ? 'thread' : 'threads'}
        </div>
      )}
      <DeskStatus loading={loading && !view} error={view ? null : error} onRetry={refresh} />
      {view && counts && (
        <section>
          <SectionHeading title={showChanges ? 'Since you left' : 'Now'} count={showChanges ? changedTotal(view.changes) : counts.waiting + counts.stalled + counts.doing + counts.done} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, padding: '12px 0' }}>
            <Count state="done" n={showChanges ? view.changes.done : counts.done} label="done" />
            <Count state="waiting" n={showChanges ? view.changes.waiting : counts.waiting} label="waiting" />
            <Count state="stalled" n={showChanges ? view.changes.stalled : counts.stalled} label="stalled" />
            <Count state="doing" n={showChanges ? view.changes.doing : counts.doing} label="in progress" />
          </div>
        </section>
      )}
      {view?.next && (
        <section style={{ marginTop: 8, padding: 14, background: 'var(--term-surface)', border: '1px solid var(--term-line)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps-wide)', color: 'var(--term-muted)' }}>Next</div>
          <div style={{ marginTop: 8, fontSize: 'var(--fs-lg)' }}>{view.next.next || view.next.stoppedAt || view.next.title}</div>
          <button type="button" onClick={() => continueThread(view.next!)} style={continueButton}>Continue</button>
        </section>
      )}
      {view && view.threads.length > 0 && (
        <section>
          <SectionHeading title="Sessions" count={view.threads.length} />
          {view.threads.map((thread) => (
            <DeskThreadRow
              key={thread.id}
              thread={thread}
              now={now}
              onOpen={() => continueThread(thread)}
              onContinue={() => continueThread(thread)}
              onArchive={thread.archived ? undefined : () => { void act('archive', [thread.id]); }}
              onIgnore={thread.archived ? undefined : () => { void act('ignore', [thread.id]); }}
              onUnarchive={thread.archived && !thread.michiArchived ? () => { void act('unarchive', [thread.id]); } : undefined}
              onMarkDone={() => { void act('done', [thread.id]); }}
            />
          ))}
        </section>
      )}
      <DeskUndoBar onUndone={refresh} />
    </DeskScroll>
  );
}

function countLive(threads: DeskThread[]) {
  const counts = { waiting: 0, stalled: 0, doing: 0, done: 0 };
  for (const thread of threads) {
    if (thread.archived || thread.state === 'idea') continue;
    counts[thread.state] += 1;
  }
  return counts;
}

function changedTotal(changes: DeskProjectView['changes']): number {
  return changes.waiting + changes.stalled + changes.doing + changes.done;
}

function Count({ state, n, label }: { state: 'waiting' | 'stalled' | 'doing' | 'done'; n: number; label: string }) {
  if (n === 0) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', color: 'var(--term-mid)' }}>
      <StatusMark state={state} />
      {n} {label}
    </span>
  );
}

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  color: 'var(--term-mid)',
  font: 'inherit',
  cursor: 'pointer',
};

const continueButton: React.CSSProperties = {
  marginTop: 12,
  background: 'var(--term-accent)',
  color: 'var(--term-bg)',
  border: 0,
  padding: '6px 12px',
  font: 'inherit',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
};
