import React, { useState } from 'react';
import { toast } from 'sonner';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import type { LauncherPaneItem, PaneLauncherChoice } from '../../state/paneItems';
import { useChatActions } from '../../state/chatStore';

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

export default function PaneChooser({ item }: { item: LauncherPaneItem }) {
  const { activateLauncherPane, focusPane, setFocusedNodeId } = useChatActions();
  const shellStyle = usePaneShellStyle(item.id);
  const [pending, setPending] = useState<PaneLauncherChoice | null>(null);

  const choose = async (choice: PaneLauncherChoice) => {
    if (pending) return;
    setPending(choice);
    try {
      await activateLauncherPane(item.id, choice);
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : 'Unable to open pane');
    }
  };

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
        {CHOICES.map((choice) => {
          const isPending = pending === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              disabled={pending !== null}
              aria-label={choice.label}
              onClick={() => { void choose(choice.id); }}
              style={{
                minHeight: 52,
                display: 'grid',
                gridTemplateColumns: '30px minmax(0, 1fr) auto',
                alignItems: 'center',
                gap: 10,
                padding: '7px 10px',
                border: '1px solid transparent',
                borderRadius: 'var(--term-control-radius, 5px)',
                background: isPending ? 'var(--term-alt)' : 'transparent',
                color: 'var(--term-fg)',
                cursor: pending ? 'default' : 'pointer',
                fontFamily: 'var(--ui-font)',
                textAlign: 'left',
                opacity: pending && !isPending ? 0.45 : 1,
                transition: 'background var(--t-quick) var(--t-ease), border-color var(--t-quick) var(--t-ease), opacity var(--t-quick) var(--t-ease)',
              }}
              onMouseEnter={(event) => {
                if (!pending) {
                  event.currentTarget.style.background = 'var(--term-alt)';
                  event.currentTarget.style.borderColor = 'var(--term-line)';
                }
              }}
              onMouseLeave={(event) => {
                if (!isPending) {
                  event.currentTarget.style.background = 'transparent';
                  event.currentTarget.style.borderColor = 'transparent';
                }
              }}
            >
              <span aria-hidden style={{ color: 'var(--term-mid)', fontFamily: 'var(--mono-font)', fontSize: 12, textAlign: 'center' }}>
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
