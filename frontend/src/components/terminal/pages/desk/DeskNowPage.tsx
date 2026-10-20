import React, { useCallback, useEffect, useState } from 'react';
import type { DeskNow, DeskThread } from 'michi-shared';
import type { PageId } from '../../../../state/commands';
import { useChatStore } from '../../../../state/chatStore';
import { openDeskProject } from '../../../../state/deskRoute';
import { getDeskNow, markDeskLooked } from '../../../../services/api/desk';
import {
  DeskScroll,
  DeskStatus,
  DeskThreadRow,
  DeskUndoBar,
  SectionHeading,
} from './DeskChrome';
import { deskDateLine } from './format';
import { openDeskThread } from './openDeskThread';
import { useDeskActions } from './useDeskActions';

export default function DeskNowPage({ onNav }: { onNav: (page: PageId) => void }) {
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [data, setData] = useState<DeskNow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((value) => value + 1), []);
  const { act } = useDeskActions(refresh);
  const navigation = useChatStore();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    getDeskNow(undefined, controller.signal)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
        setNowTick(Date.now());
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError('Couldn’t load Desk.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    const openedAt = Date.now();
    return () => {
      cancelled = true;
      controller.abort();
      if (Date.now() - openedAt > 800) void markDeskLooked().catch(() => {});
    };
  }, [reloadKey]);

  const continueThread = (thread: DeskThread) => openDeskThread(navigation, thread, onNav);
  const openProject = (thread: DeskThread) => {
    openDeskProject({ id: thread.projectId, title: thread.projectTitle });
    onNav('desk-project');
  };

  const sections: Array<{ key: 'waiting' | 'stalled' | 'done'; title: string; threads: DeskThread[]; more: number }> = data ? [
    { key: 'waiting', title: 'Waiting on you', threads: data.waiting, more: data.more.waiting },
    { key: 'stalled', title: 'Stalled', threads: data.stalled, more: data.more.stalled },
    { key: 'done', title: 'Just done', threads: data.done, more: data.more.done },
  ] : [];

  return (
    <DeskScroll label="Desk">
      {data && (
        <>
          <div style={{ fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps-wide)', color: 'var(--term-muted)' }}>
            {deskDateLine(nowTick, data.since)}
          </div>
          <h1 style={{ fontSize: 'var(--fs-4xl)', fontWeight: 520, letterSpacing: 'var(--ls-tight)', margin: '14px 0 8px', lineHeight: 1.35 }}>
            <span style={{ color: 'var(--term-accent)' }}>_ </span>
            {data.summary}
          </h1>
        </>
      )}
      <DeskStatus loading={loading && !data} error={data ? null : error} onRetry={refresh} />
      {sections.map((section) => section.threads.length === 0 ? null : (
        <section key={section.key}>
          <SectionHeading title={section.title} count={section.threads.length + section.more} />
          {section.threads.map((thread) => (
            <DeskThreadRow
              key={thread.id}
              thread={thread}
              now={nowTick}
              onOpen={() => continueThread(thread)}
              onContinue={() => continueThread(thread)}
              onOpenProject={() => openProject(thread)}
              onArchive={thread.archived ? undefined : () => { void act('archive', [thread.id]); }}
              onIgnore={thread.archived ? undefined : () => { void act('ignore', [thread.id]); }}
              onMarkDone={thread.doneBy === 'agent' ? () => { void act('done', [thread.id]); } : undefined}
            />
          ))}
          {section.more > 0 && (
            <button type="button" onClick={() => onNav('desk-threads')} style={linkButton}>
              View all
            </button>
          )}
        </section>
      ))}
      {data && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, paddingTop: 22, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>
          <span>Archived · {data.archivedCount}</span>
          <button type="button" onClick={() => onNav('desk-threads')} style={linkButton}>All threads</button>
        </div>
      )}
      <DeskUndoBar onUndone={refresh} />
    </DeskScroll>
  );
}

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 0,
  padding: '8px 0',
  color: 'var(--term-mid)',
  font: 'inherit',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
};
