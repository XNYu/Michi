import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Project } from '../../state/chatTypes';
import { useChatActions } from '../../state/chatStore';
import { getElectron } from '../../lib/electronBridge';

function relativeToWorkspace(absPath: string, cwd?: string): string | null {
  if (!cwd) return null;
  const root = cwd.replace(/\/$/, '');
  return absPath === root ? '' : absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : null;
}

export default function PaneLauncher({ project }: { project: Project }) {
  const { openFilePane, openDiffPane, openTerminalPane, openBrowserPane } = useChatActions();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('michi:native-surfaces-visible', { detail: { visible: !open } }));
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      window.removeEventListener('keydown', escape, true);
      window.dispatchEvent(new CustomEvent('michi:native-surfaces-visible', { detail: { visible: true } }));
    };
  }, [open]);

  const chooseFile = async (diff: boolean) => {
    try {
      const electron = getElectron();
      let filePath: string | null = null;
      if (electron?.chooseFiles) {
        const result = await electron.chooseFiles();
        if (result.canceled || !result.paths?.[0]) return;
        filePath = result.paths[0];
      } else {
        filePath = window.prompt(diff ? 'Workspace-relative path to diff' : 'File path');
      }
      if (!filePath) return;
      if (diff) {
        const relative = filePath.startsWith('/') ? relativeToWorkspace(filePath, project.cwd) : filePath;
        if (!relative) throw new Error('Diff files must be inside the active workspace');
        openDiffPane(relative);
      } else {
        openFilePane(filePath);
      }
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to open pane');
    }
  };

  const launch = (kind: 'terminal' | 'browser') => {
    try {
      if (kind === 'terminal') openTerminalPane();
      else openBrowserPane();
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to open pane');
    }
  };

  const options = [
    { id: 'file', glyph: '◇', label: 'File / Markdown', meta: 'viewer', run: () => { void chooseFile(false); } },
    { id: 'diff', glyph: '±', label: 'Working diff', meta: 'git', run: () => { void chooseFile(true); } },
    { id: 'terminal', glyph: '›_', label: 'Terminal', meta: project.cwd ? 'workspace cwd' : 'home', run: () => launch('terminal') },
    { id: 'browser', glyph: '◎', label: 'Browser', meta: 'native web', run: () => launch('browser') },
  ];

  return (
    <div ref={rootRef} style={{ position: 'relative', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button type="button" className="t-icon-btn" aria-label="New pane" title="New pane" onClick={() => setOpen((value) => !value)} style={{ width: 26, height: 26, fontSize: 16, color: open ? 'var(--term-fg)' : 'var(--term-mid)' }}>+</button>
      {open ? (
        <div role="menu" aria-label="New pane" style={{ position: 'absolute', right: 0, top: 31, width: 220, padding: 5, border: '1px solid var(--term-line)', background: 'var(--term-bg)', boxShadow: 'var(--term-popover-shadow)', zIndex: 1200 }}>
          <div style={{ padding: '6px 8px 7px', fontSize: 9, letterSpacing: '.12em', color: 'var(--term-muted)' }}>OPEN PANE</div>
          {options.map((option) => (
            <button key={option.id} type="button" role="menuitem" onClick={option.run} style={{ width: '100%', height: 34, display: 'grid', gridTemplateColumns: '28px 1fr auto', alignItems: 'center', gap: 6, border: 0, background: 'transparent', color: 'var(--term-fg)', padding: '0 8px', cursor: 'pointer', fontFamily: 'var(--ui-font)', textAlign: 'left' }} onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--term-alt)'; }} onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}>
              <span aria-hidden style={{ color: 'var(--term-accent)', fontFamily: 'var(--mono-font)', fontSize: 12 }}>{option.glyph}</span>
              <span style={{ fontSize: 11.5 }}>{option.label}</span>
              <span style={{ fontSize: 9.5, color: 'var(--term-muted)' }}>{option.meta}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
