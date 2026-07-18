import React, { useEffect, useRef, useState } from 'react';
import { getElectron } from '../lib/electronBridge';
import { ModalShell } from './ui/ModalShell';
import { Button } from './ui/controls';

interface NewWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (workspaceName: string | undefined, cwd: string | undefined) => void;
  /** Called when the user picks Skip — opens the singleton Chats workspace. */
  onSkip: () => void;
}

// showDirectoryPicker is not in the default TS lib; narrow type.
type DirectoryPicker = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>;

// name + folder rows share one surface color so they read as a continuous
// field group (they previously diverged: surface vs alt).
const PROMPT_ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderBottom: '1px solid var(--term-line)',
  background: 'var(--term-surface)',
};

const PROMPT_GLYPH: React.CSSProperties = {
  fontFamily: 'var(--mono-font, ui-monospace, monospace)',
  fontSize: 12.5,
  color: 'var(--term-accent)',
  flexShrink: 0,
};

const PROMPT_LABEL: React.CSSProperties = {
  fontFamily: 'var(--mono-font, ui-monospace, monospace)',
  fontSize: 11,
  color: 'var(--term-mid)',
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
  color: 'var(--term-fg)',
  padding: 0,
};

export default function NewWorkspaceDialog({ open, onClose, onCreate, onSkip }: NewWorkspaceDialogProps) {
  const [name, setName] = useState<string>('');
  const [folderName, setFolderName] = useState<string | null>(null);
  const [absolutePath, setAbsolutePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setFolderName(null);
      setAbsolutePath(null);
      setError(null);
      setFolderNotice(null);
    }
  }, [open]);

  if (!open) return null;

  const pickFolder = async () => {
    setError(null);
    setFolderNotice(null);

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
        setFolderNotice(
          `Browsers cannot link an absolute local folder. “${handle.name}” will only be used as the workspace name; the agent will not receive filesystem access.`,
        );
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setError('Could not read that folder. You can create a quick chat instead.');
        return;
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
        setFolderNotice(
          `Browsers cannot link an absolute local folder. “${first}” will only be used as the workspace name; the agent will not receive filesystem access.`,
        );
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

  const browserNameOnly = !!folderName && !absolutePath;
  const folderDisplay = absolutePath || (folderName ? `${folderName} — not linked` : null);

  return (
    <ModalShell open={open} onClose={onClose} title="New workspace" titleGlyph="▸" width={480}>
        <div style={PROMPT_ROW}>
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
              }
            }}
          />
        </div>

        <div style={PROMPT_ROW}>
          <span style={PROMPT_GLYPH} aria-hidden>›_</span>
          <span style={PROMPT_LABEL}>folder</span>
          <span
            title={folderDisplay ?? undefined}
            style={{
              ...PROMPT_INPUT,
              fontFamily: folderDisplay
                ? 'var(--mono-font, ui-monospace, monospace)'
                : 'var(--ui-font)',
              fontSize: folderDisplay ? 12.5 : 13.5,
              color: folderDisplay ? 'var(--term-fg)' : 'var(--term-mid)',
              fontStyle: folderDisplay ? 'normal' : 'italic',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {folderDisplay ?? '(optional)'}
          </span>
          <Button variant="secondary" size="sm" onClick={pickFolder} style={{ flexShrink: 0 }}>
            browse…
          </Button>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 14px 0',
              fontSize: 12,
              color: 'var(--term-danger)',
              fontFamily: 'var(--ui-font)',
            }}
          >
            {error}
          </div>
        )}

        {folderNotice && (
          <div
            role="status"
            style={{
              padding: '9px 14px 0',
              fontSize: 11.5,
              lineHeight: 1.45,
              color: 'var(--term-mid)',
              fontFamily: 'var(--ui-font)',
            }}
          >
            {folderNotice} Use the desktop app to link or change a folder later.
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

        <div style={{ padding: '14px 14px 16px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>cancel</Button>
          <Button variant="secondary" onClick={onSkip}>open quick chat</Button>
          <Button variant="primary" onClick={handleCreate}>
            {browserNameOnly ? 'create without folder' : 'create'}
          </Button>
        </div>
    </ModalShell>
  );
}
