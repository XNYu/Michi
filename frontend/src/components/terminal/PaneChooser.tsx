import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import type { LauncherPaneItem, PaneLauncherChoice, TerminalPaneItem } from '../../state/paneItems';
import { useChatActions, useChatPanes } from '../../state/chatStore';

const CHOICES: Array<{
  id: PaneLauncherChoice;
  glyph: string;
  label: string;
  description: string;
  shortcut?: string;
}> = [
  { id: 'review', glyph: '±', label: 'Review', description: 'Inspect workspace changes', shortcut: '⇧⌘G' },
  { id: 'terminal', glyph: '>_', label: 'Terminal', description: 'Start in this workspace', shortcut: '^`' },
  { id: 'browser', glyph: '◎', label: 'Browser', description: 'Open a native web surface', shortcut: '⌘T' },
  { id: 'files', glyph: '▱', label: 'Files', description: 'Browse workspace and artifacts', shortcut: '⌘P' },
  { id: 'side-chat', glyph: '⊕', label: 'Side chat', description: 'Create a blank branch', shortcut: '⌥⌘S' },
];

const buttonStyle: React.CSSProperties = {
  minHeight: 52,
  display: 'grid',
  gridTemplateColumns: '30px minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 10,
  padding: '7px 10px',
  border: '1px solid transparent',
  borderRadius: 'var(--term-control-radius, 5px)',
  background: 'transparent',
  color: 'var(--term-fg)',
  cursor: 'pointer',
  fontFamily: 'var(--ui-font)',
  textAlign: 'left' as const,
  transition: 'background var(--t-quick) var(--t-ease), border-color var(--t-quick) var(--t-ease), opacity var(--t-quick) var(--t-ease)',
};

function hoverOn(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'var(--term-alt)';
  event.currentTarget.style.borderColor = 'var(--term-line)';
}

function hoverOff(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.style.background = 'transparent';
  event.currentTarget.style.borderColor = 'transparent';
}

/** Truncate a cwd path to something legible inside the chooser. */
function shortCwd(cwd: string): string {
  if (!cwd) return '~';
  // Show last 2 path segments at most.
  const parts = cwd.replace(/\/$/, '').split('/');
  if (parts.length <= 3) return cwd.startsWith('/') ? cwd : `~/${cwd}`;
  return `…/${parts.slice(-2).join('/')}`;
}

export default function PaneChooser({ item }: { item: LauncherPaneItem }) {
  const { activateLauncherPane, adoptTerminalPane, focusPane, setFocusedNodeId } = useChatActions();
  const { paneItems, openPanes } = useChatPanes();
  const shellStyle = usePaneShellStyle(item.id);
  const [pending, setPending] = useState<PaneLauncherChoice | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);

  const detachedTerminals = useMemo(() => {
    const openSet = new Set(openPanes);
    return Object.values(paneItems).filter(
      (entry): entry is TerminalPaneItem =>
        entry.kind === 'terminal' && !openSet.has(entry.id),
    );
  }, [paneItems, openPanes]);

  const choose = async (choice: PaneLauncherChoice) => {
    if (pending || adopting) return;
    setPending(choice);
    try {
      await activateLauncherPane(item.id, choice);
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : 'Unable to open pane');
    }
  };

  const adopt = (terminalId: string) => {
    if (pending || adopting) return;
    setAdopting(terminalId);
    adoptTerminalPane(item.id, terminalId);
  };

  const busy = pending !== null || adopting !== null;

  return (
    <div
      data-pane-id={item.id}
      data-pane-kind="launcher"
      className="terminal-pane"
      onMouseDown={() => { focusPane(item.id); setFocusedNodeId(null); }}
      style={{ ...shellStyle, justifyContent: 'center' }}
    >
      <div
        aria-label="Choose pane type"
        style={{
          width: 'min(420px, calc(100% - 48px))',
          margin: '0 auto',
          display: 'grid',
          gap: 3,
        }}
      >
        {/* ── Detached terminal section ── */}
        {detachedTerminals.length > 0 && (
          <>
            <div style={{ fontSize: 9, color: 'var(--term-muted)', padding: '0 10px', marginBottom: 2, fontFamily: 'var(--ui-font)', letterSpacing: '0.03em', textTransform: 'uppercase' }}>
              Running terminals
            </div>
            {detachedTerminals.map((term) => {
              const isAdopting = adopting === term.id;
              return (
                <button
                  key={term.id}
                  type="button"
                  disabled={busy}
                  aria-label={`Resume terminal — ${term.cwd || '~'}`}
                  onClick={() => adopt(term.id)}
                  onMouseEnter={busy ? undefined : hoverOn}
                  onMouseLeave={isAdopting ? undefined : hoverOff}
                  style={{
                    ...buttonStyle,
                    background: isAdopting ? 'var(--term-alt)' : 'transparent',
                    opacity: busy && !isAdopting ? 0.45 : 1,
                    cursor: busy ? 'default' : 'pointer',
                  }}
                >
                  <span aria-hidden style={{ color: 'var(--term-digest)', fontFamily: 'var(--mono-font)', fontSize: 12, textAlign: 'center' }}>
                    {isAdopting ? '…' : '●'}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 12.5, fontWeight: 500, lineHeight: 1.3 }}>Terminal</span>
                    <span style={{ display: 'block', marginTop: 2, color: 'var(--term-muted)', fontSize: 10.5, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortCwd(term.cwd)}
                    </span>
                  </span>
                </button>
              );
            })}
            <div style={{ borderBottom: '1px solid var(--term-line)', margin: '4px 0' }} />
          </>
        )}

        {/* ── Standard choices ── */}
        {CHOICES.map((choice) => {
          const isPending = pending === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              disabled={busy}
              aria-label={choice.label}
              onClick={() => { void choose(choice.id); }}
              style={{
                ...buttonStyle,
                background: isPending ? 'var(--term-alt)' : 'transparent',
                opacity: busy && !isPending ? 0.45 : 1,
                cursor: busy ? 'default' : 'pointer',
              }}
              onMouseEnter={busy ? undefined : hoverOn}
              onMouseLeave={isPending ? undefined : hoverOff}
            >
              <span aria-hidden style={{ color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 12, textAlign: 'center' }}>
                {isPending ? '…' : choice.glyph}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 500, lineHeight: 1.3 }}>{choice.label}</span>
                <span style={{ display: 'block', marginTop: 2, color: 'var(--term-muted)', fontSize: 10.5, lineHeight: 1.3 }}>{choice.description}</span>
              </span>
              {choice.shortcut ? (
                <kbd style={{ color: 'var(--term-muted)', background: 'var(--term-alt)', border: '1px solid var(--term-line)', borderRadius: 4, padding: '1px 5px', fontFamily: 'var(--ui-font)', fontSize: 9.5, whiteSpace: 'nowrap' }}>
                  {choice.shortcut}
                </kbd>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
