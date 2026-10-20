import React, { useSyncExternalStore } from 'react';
import type { DeskThread } from 'michi-shared';
import { undoDeskReceipt, type DeskMutation } from '../../../../services/api/desk';
import { StatusMark } from './StatusMark';
import { shortAge } from './format';

interface UndoNotice {
  id: string;
  label: string;
}

let undoNotice: UndoNotice | null = null;
const undoListeners = new Set<() => void>();

function emitUndo(): void {
  undoListeners.forEach((listener) => listener());
}

export function setDeskUndo(notice: UndoNotice | null): void {
  undoNotice = notice;
  emitUndo();
}

export function useDeskUndo(): UndoNotice | null {
  return useSyncExternalStore(
    (listener) => {
      undoListeners.add(listener);
      return () => undoListeners.delete(listener);
    },
    () => undoNotice,
    () => undoNotice,
  );
}

export function deskUndoLabel(action: DeskMutation, count: number): string {
  const many = count === 1 ? '' : ` ${count}`;
  switch (action) {
    case 'archive': return `Archived${many}`;
    case 'ignore': return `Ignored${many}`;
    case 'done': return count === 1 ? 'Marked done' : `Marked ${count} done`;
    case 'unarchive':
    case 'unignore':
      return count === 1 ? 'Restored' : `Restored ${count}`;
  }
}

export function DeskScroll({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <main
      aria-label={label}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        background: 'var(--term-bg)',
        color: 'var(--term-fg)',
        fontFamily: 'var(--ui-font)',
      }}
    >
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '28px 32px 72px' }}>
        {children}
      </div>
    </main>
  );
}

export function DeskStatus({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (!loading && !error) return null;
  return (
    <div role={error ? 'alert' : 'status'} style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-md)', padding: '12px 0' }}>
      <span>{error ?? 'Loading…'}</span>
      {error && (
        <button type="button" onClick={onRetry} style={quietButton}>Retry</button>
      )}
    </div>
  );
}

export function SectionHeading({ title, count }: { title: string; count: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        padding: '18px 0 8px',
        borderBottom: '1px solid var(--term-line)',
        fontSize: 'var(--fs-xs)',
        letterSpacing: 'var(--ls-caps-wide)',
        textTransform: 'uppercase',
        color: 'var(--term-muted)',
      }}
    >
      <span>{title}</span>
      <span style={{ fontFamily: 'var(--font-mono)' }}>{count}</span>
    </div>
  );
}

export function DeskThreadRow({
  thread,
  now,
  onOpen,
  onContinue,
  onOpenProject,
  onArchive,
  onIgnore,
  onUnarchive,
  onMarkDone,
}: {
  thread: DeskThread;
  now: number;
  onOpen: () => void;
  onContinue: () => void;
  onOpenProject?: () => void;
  onArchive?: () => void;
  onIgnore?: () => void;
  onUnarchive?: () => void;
  onMarkDone?: () => void;
}) {
  return (
    <div
      data-testid="desk-thread"
      style={{
        display: 'flex',
        gap: 10,
        padding: '12px 4px',
        borderBottom: '1px solid var(--term-line)',
      }}
    >
      <span style={{ paddingTop: 4 }}>
        <StatusMark state={thread.state} doneBy={thread.doneBy} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <button type="button" onClick={onOpen} style={titleButton}>
            {thread.title}
          </button>
          {thread.returned && <Meta>returned</Meta>}
          {thread.doneBy === 'agent' && onMarkDone && (
            <button type="button" onClick={onMarkDone} style={quietButton}>Confirm done</button>
          )}
          <span style={{ flex: 1 }} />
          {onOpenProject ? (
            <button type="button" onClick={onOpenProject} style={metaButton}>{thread.projectTitle}</button>
          ) : (
            <Meta>{thread.projectTitle}</Meta>
          )}
          <Meta>{shortAge(thread.lastActivityAt, now)}</Meta>
        </div>
        {thread.stoppedAt && (
          <div style={{ color: 'var(--term-mid)', fontSize: 'var(--fs-md)', marginTop: 3 }}>{thread.stoppedAt}</div>
        )}
        {thread.next && (
          <div style={{ color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', marginTop: 3 }}>Next · {thread.next}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onContinue} style={continueButton}>Continue</button>
          {onArchive && <button type="button" onClick={onArchive} style={quietButton}>Archive</button>}
          {onIgnore && <button type="button" onClick={onIgnore} style={quietButton}>Ignore</button>}
          {onUnarchive && <button type="button" onClick={onUnarchive} style={quietButton}>Unarchive</button>}
        </div>
      </div>
    </div>
  );
}

export function DeskUndoBar({ onUndone }: { onUndone: () => void }) {
  const notice = useDeskUndo();
  if (!notice) return null;
  return (
    <div
      style={{
        position: 'sticky',
        bottom: 16,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: 'var(--sel-bar-bg)',
          color: 'var(--sel-bar-fg)',
          border: '1px solid var(--sel-bar-line)',
          boxShadow: 'var(--sel-bar-shadow)',
          padding: '8px 12px',
          fontSize: 'var(--fs-md)',
        }}
      >
        <span>{notice.label}</span>
        <button
          type="button"
          style={{ ...quietButton, color: 'inherit' }}
          onClick={() => {
            const id = notice.id;
            setDeskUndo(null);
            void undoDeskReceipt(id).then(onUndone).catch(onUndone);
          }}
        >
          Undo
        </button>
      </div>
    </div>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--term-muted)', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

const titleButton: React.CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  color: 'var(--term-fg)',
  font: 'inherit',
  fontSize: 'var(--fs-lg)',
  textAlign: 'left',
  cursor: 'pointer',
};

const metaButton: React.CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  color: 'var(--term-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-xs)',
  cursor: 'pointer',
};

const quietButton: React.CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  marginLeft: 8,
  color: 'var(--term-muted)',
  font: 'inherit',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
};

const continueButton: React.CSSProperties = {
  background: 'var(--term-accent)',
  color: 'var(--term-bg)',
  border: 0,
  padding: '4px 10px',
  font: 'inherit',
  fontSize: 'var(--fs-sm)',
  cursor: 'pointer',
};
