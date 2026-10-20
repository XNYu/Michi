import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeskThread, DeskThreadState } from 'michi-shared';
import type { PageId } from '../../../../state/commands';
import { useChatStore } from '../../../../state/chatStore';
import { getDeskThreads } from '../../../../services/api/desk';
import {
  DeskScroll,
  DeskStatus,
  DeskThreadRow,
  DeskUndoBar,
  SectionHeading,
} from './DeskChrome';
import { StatusMark } from './StatusMark';
import { ThreadDrawer } from './ThreadDrawer';
import { dayKey, dayLabel, stateLabel } from './format';
import { openDeskThread } from './openDeskThread';
import { useDeskActions } from './useDeskActions';

type DeskView = 'board' | 'table' | 'timeline' | 'calendar';

const COLUMNS: DeskThreadState[] = ['waiting', 'doing', 'stalled', 'done', 'idea'];

export default function DeskThreadsPage({ onNav }: { onNav: (page: PageId) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [threads, setThreads] = useState<DeskThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<DeskView>('board');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [calendarCursor, setCalendarCursor] = useState(() => new Date());
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const refresh = useCallback(() => setReloadKey((value) => value + 1), []);
  const { act } = useDeskActions(refresh);
  const navigation = useChatStore();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    getDeskThreads(controller.signal)
      .then((next) => {
        if (cancelled) return;
        setThreads(next.threads);
        setError(null);
        setNow(Date.now());
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError('Couldn’t load threads.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [reloadKey]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = threads ?? [];
    if (!needle) return list;
    return list.filter((thread) => (
      thread.title.toLowerCase().includes(needle)
      || thread.projectTitle.toLowerCase().includes(needle)
      || thread.stoppedAt.toLowerCase().includes(needle)
      || (thread.next ?? '').toLowerCase().includes(needle)
    ));
  }, [threads, query]);

  const openThread = visible.find((thread) => thread.id === openId) ?? null;
  const continueThread = (thread: DeskThread) => openDeskThread(navigation, thread, onNav);
  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runSelected = (action: 'archive' | 'ignore' | 'done') => {
    const ids = [...selected];
    setSelected(new Set());
    setOpenId(null);
    void act(action, ids);
  };

  return (
    <DeskScroll label="All threads">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
        <div role="tablist" aria-label="Thread views" style={{ display: 'flex', gap: 6 }}>
          {(['board', 'table', 'timeline', 'calendar'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={view === name}
              onClick={() => setView(name)}
              style={view === name ? tabOn : tabOff}
            >
              {name[0].toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>
        <input
          aria-label="Filter threads"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter"
          style={filterInput}
        />
      </div>
      <DeskStatus loading={loading && !threads} error={threads ? null : error} onRetry={refresh} />
      {threads && view === 'board' && (
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', overflowX: 'auto', paddingTop: 16 }}>
          {[
            ...COLUMNS.map((state) => ({
              key: state,
              title: stateLabel(state),
              threads: visible.filter((thread) => !thread.archived && thread.state === state),
            })),
            {
              key: 'archived',
              title: 'Archived',
              threads: visible.filter((thread) => thread.archived),
            },
          ].filter((column) => column.key !== 'archived' || column.threads.length > 0).map((column) => (
              <section key={column.key} style={{ flex: '1 1 180px', minWidth: 200 }}>
                <SectionHeading title={column.title} count={column.threads.length} />
                {column.threads.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    selected={selected.has(thread.id)}
                    onToggle={() => toggle(thread.id)}
                    onOpen={() => setOpenId(thread.id)}
                  />
                ))}
              </section>
          ))}
        </div>
      )}
      {threads && view === 'table' && (
        <div style={{ paddingTop: 12 }}>
          {visible.map((thread) => (
            <div key={thread.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                aria-label={`Select ${thread.title}`}
                checked={selected.has(thread.id)}
                onChange={() => toggle(thread.id)}
                style={{ marginTop: 16 }}
              />
              <div style={{ flex: 1 }}>
                <DeskThreadRow
                  thread={thread}
                  now={now}
                  onOpen={() => setOpenId(thread.id)}
                  onContinue={() => continueThread(thread)}
                  onArchive={thread.archived ? undefined : () => { void act('archive', [thread.id]); }}
                  onIgnore={thread.archived ? undefined : () => { void act('ignore', [thread.id]); }}
                  onUnarchive={thread.archived && !thread.michiArchived ? () => { void act('unarchive', [thread.id]); } : undefined}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {threads && view === 'timeline' && <Timeline threads={visible} onOpen={setOpenId} />}
      {threads && view === 'calendar' && (
        <Calendar
          threads={visible}
          cursor={calendarCursor}
          selectedDay={calendarDay}
          onCursor={setCalendarCursor}
          onDay={setCalendarDay}
          onOpen={setOpenId}
        />
      )}
      {selected.size > 0 && (
        <div style={batchBar}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{selected.size} selected</span>
          <button type="button" style={batchButton} onClick={() => runSelected('archive')}>Archive</button>
          <button type="button" style={batchButton} onClick={() => runSelected('ignore')}>Ignore</button>
          <button type="button" style={batchButton} onClick={() => runSelected('done')}>Mark done</button>
          <button type="button" style={batchButton} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      <ThreadDrawer
        thread={openThread}
        now={now}
        onClose={() => setOpenId(null)}
        onContinue={continueThread}
        onArchive={(thread) => { setOpenId(null); void act('archive', [thread.id]); }}
        onIgnore={(thread) => { setOpenId(null); void act('ignore', [thread.id]); }}
        onUnarchive={(thread) => { setOpenId(null); void act('unarchive', [thread.id]); }}
        onMarkDone={(thread) => { setOpenId(null); void act('done', [thread.id]); }}
      />
      <DeskUndoBar onUndone={refresh} />
    </DeskScroll>
  );
}

function ThreadCard({
  thread,
  selected,
  onToggle,
  onOpen,
}: {
  thread: DeskThread;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface)', padding: 10, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <input type="checkbox" aria-label={`Select ${thread.title}`} checked={selected} onChange={onToggle} />
        <button type="button" onClick={onOpen} style={cardButton}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <StatusMark state={thread.state} doneBy={thread.doneBy} />
            <span>{thread.title}</span>
          </span>
          {thread.stoppedAt && <span style={{ display: 'block', color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>{thread.stoppedAt}</span>}
        </button>
      </div>
    </div>
  );
}

function Timeline({ threads, onOpen }: { threads: DeskThread[]; onOpen: (id: string) => void }) {
  const groups = new Map<string, DeskThread[]>();
  const sorted = [...threads].sort((a, b) => (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1));
  for (const thread of sorted) {
    const key = dayKey(thread.lastActivityAt);
    const list = groups.get(key) ?? [];
    list.push(thread);
    groups.set(key, list);
  }
  return (
    <div style={{ paddingTop: 8 }}>
      {[...groups.entries()].map(([key, list]) => (
        <section key={key}>
          <SectionHeading title={dayLabel(key)} count={list.length} />
          {list.map((thread) => (
            <button key={thread.id} type="button" onClick={() => onOpen(thread.id)} style={timelineRow}>
              <StatusMark state={thread.state} doneBy={thread.doneBy} />
              <span style={{ flex: 1, textAlign: 'left' }}>{thread.title}</span>
              <span style={{ color: 'var(--term-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>{thread.projectTitle}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

function Calendar({
  threads,
  cursor,
  selectedDay,
  onCursor,
  onDay,
  onOpen,
}: {
  threads: DeskThread[];
  cursor: Date;
  selectedDay: string | null;
  onCursor: (next: Date) => void;
  onDay: (key: string) => void;
  onOpen: (id: string) => void;
}) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const counts = new Map<string, number>();
  for (const thread of threads) {
    const key = dayKey(thread.lastActivityAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const first = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [...Array(first).fill(null), ...Array.from({ length: days }, (_, index) => index + 1)];
  const selected = threads.filter((thread) => selectedDay != null && dayKey(thread.lastActivityAt) === selectedDay);
  return (
    <div style={{ paddingTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <button type="button" style={tabOff} onClick={() => onCursor(new Date(year, month - 1, 1))}>Prev</button>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>
          {cursor.toLocaleString('en-US', { month: 'long', year: 'numeric' })}
        </span>
        <button type="button" style={tabOff} onClick={() => onCursor(new Date(year, month + 1, 1))}>Next</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 4 }}>
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, index) => (
          <div key={`${label}-${index}`} style={{ fontSize: 'var(--fs-2xs)', color: 'var(--term-muted)', textAlign: 'center' }}>{label}</div>
        ))}
        {cells.map((day, index) => {
          if (day == null) return <div key={`pad-${index}`} />;
          const key = dayKey(new Date(year, month, day).getTime());
          const count = counts.get(key) ?? 0;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onDay(key)}
              aria-pressed={selectedDay === key}
              style={{
                minHeight: 42,
                border: '1px solid var(--term-line)',
                background: selectedDay === key ? 'var(--term-alt)' : 'transparent',
                color: 'var(--term-fg)',
                font: 'inherit',
                cursor: 'pointer',
              }}
            >
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>{day}</span>
              {count > 0 && <span style={{ display: 'block', color: 'var(--term-accent)', fontSize: 'var(--fs-2xs)' }}>{count}</span>}
            </button>
          );
        })}
      </div>
      {selectedDay && (
        <div style={{ marginTop: 12 }}>
          {selected.map((thread) => (
            <button key={thread.id} type="button" onClick={() => onOpen(thread.id)} style={timelineRow}>
              <StatusMark state={thread.state} doneBy={thread.doneBy} />
              <span>{thread.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const tabOff: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--term-muted)',
  border: '1px solid transparent',
  padding: '4px 8px',
  font: 'inherit',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
};

const tabOn: React.CSSProperties = {
  ...tabOff,
  color: 'var(--term-fg)',
  borderColor: 'var(--term-line)',
  background: 'var(--term-alt)',
};

const filterInput: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--term-fg)',
  border: '1px solid var(--term-line)',
  padding: '6px 8px',
  font: 'inherit',
  fontSize: 'var(--fs-sm)',
  minWidth: 160,
};

const cardButton: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'none',
  border: 0,
  padding: 0,
  color: 'var(--term-fg)',
  font: 'inherit',
  fontSize: 'var(--fs-md)',
  textAlign: 'left',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
};

const timelineRow: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'none',
  border: 0,
  borderBottom: '1px solid var(--term-line)',
  padding: '10px 2px',
  color: 'var(--term-fg)',
  font: 'inherit',
  cursor: 'pointer',
};

const batchBar: React.CSSProperties = {
  position: 'sticky',
  bottom: 16,
  marginTop: 16,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  background: 'var(--sel-bar-bg)',
  color: 'var(--sel-bar-fg)',
  border: '1px solid var(--sel-bar-line)',
  boxShadow: 'var(--sel-bar-shadow)',
  padding: '8px 12px',
  fontSize: 'var(--fs-md)',
};

const batchButton: React.CSSProperties = {
  background: 'transparent',
  color: 'inherit',
  border: 0,
  font: 'inherit',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
};
