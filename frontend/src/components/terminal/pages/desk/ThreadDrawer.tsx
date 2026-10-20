import React, { useEffect, useState } from 'react';
import type { DeskPeek, DeskThread } from 'michi-shared';
import { DrawerShell } from '../../../ui/DrawerShell';
import { getDeskPeek } from '../../../../services/api/desk';
import { StatusMark } from './StatusMark';
import { shortAge, stateLabel } from './format';

export function ThreadDrawer({
  thread,
  now,
  onClose,
  onContinue,
  onArchive,
  onIgnore,
  onUnarchive,
  onMarkDone,
}: {
  thread: DeskThread | null;
  now: number;
  onClose: () => void;
  onContinue: (thread: DeskThread) => void;
  onArchive: (thread: DeskThread) => void;
  onIgnore: (thread: DeskThread) => void;
  onUnarchive: (thread: DeskThread) => void;
  onMarkDone: (thread: DeskThread) => void;
}) {
  const [peek, setPeek] = useState<DeskPeek | null>(null);

  useEffect(() => {
    if (!thread) {
      setPeek(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    getDeskPeek(thread.id, controller.signal)
      .then((next) => { if (!cancelled) setPeek(next); })
      .catch(() => { if (!cancelled) setPeek(null); });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [thread]);

  return (
    <DrawerShell open={thread != null} onClose={onClose} title="Thread" width={420}>
      {thread && (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 18px 28px', fontFamily: 'var(--ui-font)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>
            <StatusMark state={thread.state} doneBy={thread.doneBy} />
            <span>{stateLabel(thread.state)}</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{shortAge(thread.lastActivityAt, now)}</span>
          </div>
          <h2 style={{ fontSize: 'var(--fs-2xl)', fontWeight: 560, margin: '10px 0 4px', overflowWrap: 'anywhere' }}>{thread.title}</h2>
          <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)' }}>{thread.projectTitle}</div>
          {thread.stoppedAt && <p style={{ color: 'var(--term-mid)', fontSize: 'var(--fs-md)', lineHeight: 1.5 }}>{thread.stoppedAt}</p>}
          {thread.next && <p style={{ color: 'var(--term-fg)', fontSize: 'var(--fs-md)' }}>Next · {thread.next}</p>}
          {peek && peek.recent.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
              {peek.recent.map((message, index) => (
                <div key={`${message.at ?? 't'}-${index}`}>
                  <div style={{ fontSize: 'var(--fs-2xs)', letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase', color: 'var(--term-muted)' }}>
                    {message.role === 'user' ? 'You' : 'Assistant'}
                  </div>
                  <div style={{ fontSize: 'var(--fs-md)', color: 'var(--term-fg)', whiteSpace: 'pre-wrap' }}>{message.text}</div>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 }}>
            <Action onClick={() => onContinue(thread)} primary>Continue</Action>
            {thread.archived && !thread.michiArchived
              ? <Action onClick={() => onUnarchive(thread)}>Unarchive</Action>
              : !thread.archived && <Action onClick={() => onArchive(thread)}>Archive</Action>}
            {!thread.archived && <Action onClick={() => onIgnore(thread)}>Ignore</Action>}
            {thread.state !== 'done' && <Action onClick={() => onMarkDone(thread)}>Mark done</Action>}
            {thread.doneBy === 'agent' && <Action onClick={() => onMarkDone(thread)}>Confirm done</Action>}
          </div>
        </div>
      )}
    </DrawerShell>
  );
}

function Action({ children, onClick, primary = false }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: primary ? 'var(--term-accent)' : 'transparent',
        color: primary ? 'var(--term-bg)' : 'var(--term-mid)',
        border: primary ? 0 : '1px solid var(--term-line)',
        padding: '6px 10px',
        font: 'inherit',
        fontSize: 'var(--fs-sm)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
