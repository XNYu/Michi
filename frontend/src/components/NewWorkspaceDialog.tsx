import React, { useEffect, useRef, useState } from 'react';
import { getElectron } from '../lib/electronBridge';

interface NewWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (workspaceName: string | undefined, cwd: string | undefined) => void;
  /** Called when the user picks Skip — opens the singleton Chats workspace. */
  onSkip: () => void;
}

// showDirectoryPicker is not in the default TS lib; narrow type.
type DirectoryPicker = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>;

const SCRIM: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(28,25,23,0.18)',
  zIndex: 50,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  animation: 'fadeIn 150ms ease-out both',
};

const PANE: React.CSSProperties = {
  position: 'relative',
  width: 480,
  background: 'var(--surface)',
  border: '1px solid var(--line-strong)',
  borderRadius: 0,
  boxShadow:
    '0 1px 0 rgba(0,0,0,.02), 0 1px 2px rgba(0,0,0,.04), 0 14px 28px -12px rgba(28,25,23,.28), inset 0 0 0 1px var(--surface)',
  fontFamily: 'var(--ui-font)',
  animation: 'scaleIn 180ms cubic-bezier(.2,.8,.2,1) both',
};

const TAB_BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 30,
  padding: '0 8px 0 12px',
  background: 'var(--surface-muted)',
  borderBottom: '1px solid var(--line)',
};

const TAB_TAG: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 10.5,
  letterSpacing: '.14em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};

const X_BTN: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--fg-subtle, var(--fg-muted))',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  width: 18,
  height: 18,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const promptRow = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid var(--line)',
  background: active ? 'var(--surface)' : 'var(--app-bg)',
});

const PROMPT_GLYPH: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 12.5,
  color: 'var(--accent)',
  flexShrink: 0,
};

const PROMPT_LABEL: React.CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  color: 'var(--fg-muted)',
  flexShrink: 0,
  width: 56,
};

const PROMPT_INPUT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontFamily: 'var(--ui-font)',
  fontSize: 14,
  color: 'var(--fg)',
  padding: 0,
};

const FOOTER: React.CSSProperties = {
  padding: '14px 14px 16px',
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
};

const BTN_GHOST: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 12,
  border: 'none',
  background: 'transparent',
  color: 'var(--fg-muted)',
  padding: '6px 10px',
  cursor: 'pointer',
};

const BTN_SECONDARY: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 12,
  border: '1px solid var(--line-strong)',
  background: 'var(--surface)',
  color: 'var(--fg)',
  padding: '6px 12px',
  cursor: 'pointer',
  borderRadius: 0,
};

const BTN_PRIMARY: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 12,
  fontWeight: 600,
  border: '1px solid var(--accent)',
  background: 'var(--accent)',
  color: 'var(--accent-fg)',
  padding: '6px 14px',
  cursor: 'pointer',
  borderRadius: 0,
};

export default function NewWorkspaceDialog({ open, onClose, onCreate, onSkip }: NewWorkspaceDialogProps) {
  const [name, setName] = useState<string>('');
  const [folderName, setFolderName] = useState<string | null>(null);
  const [absolutePath, setAbsolutePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setFolderName(null);
      setAbsolutePath(null);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const pickFolder = async () => {
    setError(null);

    // Electron path — always preferred; returns an absolute path.
    const electron = getElectron();
    if (electron) {
      const r = await electron.chooseFolder();
      if (r.canceled || !r.path || !r.name) return;
      setFolderName(r.name);
      setAbsolutePath(r.path);
      return;
    }

    // Browser fallback: showDirectoryPicker, then webkitdirectory.
    const pick = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
    if (pick) {
      try {
        const handle = await pick();
        setFolderName(handle.name);
        setAbsolutePath(null);
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
      }
    }
    fallbackInputRef.current?.click();
  };

  const onFallbackChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const relPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (relPath) {
      const first = relPath.split('/')[0];
      if (first) {
        setFolderName(first);
        setAbsolutePath(null);
      }
    }
    e.target.value = '';
  };

  const trimmedName = name.trim();
  // If the user typed nothing and picked no folder, pass undefined so the
  // store auto-generates an Untitled-N name.
  const finalName = trimmedName || folderName || undefined;

  const handleCreate = () => {
    onCreate(finalName, absolutePath ?? undefined);
  };

  const folderDisplay = absolutePath || folderName;

  return (
    <div style={SCRIM} onClick={onClose}>
      <div style={PANE} onClick={(e) => e.stopPropagation()}>
        <div style={TAB_BAR}>
          <span style={TAB_TAG}>
            <span aria-hidden>▸</span> NEW WORKSPACE
          </span>
          <button type="button" onClick={onClose} aria-label="Close" style={X_BTN}>×</button>
        </div>

        <div style={promptRow(true)}>
          <span style={PROMPT_GLYPH} aria-hidden>›_</span>
          <span style={PROMPT_LABEL}>name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={folderName ?? 'untitled workspace'}
            autoFocus
            style={PROMPT_INPUT}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreate();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>

        <div style={promptRow(false)}>
          <span style={PROMPT_GLYPH} aria-hidden>›_</span>
          <span style={PROMPT_LABEL}>folder</span>
          <span
            title={folderDisplay ?? undefined}
            style={{
              ...PROMPT_INPUT,
              fontFamily: folderDisplay
                ? 'var(--font-mono, ui-monospace, monospace)'
                : 'var(--ui-font)',
              fontSize: folderDisplay ? 12.5 : 13.5,
              color: folderDisplay ? 'var(--fg)' : 'var(--fg-muted)',
              fontStyle: folderDisplay ? 'normal' : 'italic',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {folderDisplay ?? '(optional)'}
          </span>
          <button
            type="button"
            onClick={pickFolder}
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 11,
              border: '1px solid var(--line-strong)',
              background: 'var(--surface)',
              color: 'var(--fg)',
              padding: '2px 8px',
              cursor: 'pointer',
              borderRadius: 0,
              flexShrink: 0,
            }}
          >
            browse…
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 14px 0',
              fontSize: 12,
              color: 'var(--term-danger, #dc2626)',
              fontFamily: 'var(--ui-font)',
            }}
          >
            {error}
          </div>
        )}

        <input
          ref={fallbackInputRef}
          type="file"
          /* @ts-expect-error non-standard but widely supported */
          webkitdirectory=""
          directory=""
          multiple
          hidden
          onChange={onFallbackChange}
        />

        <div style={FOOTER}>
          <button type="button" onClick={onClose} style={BTN_GHOST}>cancel</button>
          <button type="button" onClick={onSkip} style={BTN_SECONDARY}>skip</button>
          <button type="button" onClick={handleCreate} style={BTN_PRIMARY}>create</button>
        </div>
      </div>
    </div>
  );
}
