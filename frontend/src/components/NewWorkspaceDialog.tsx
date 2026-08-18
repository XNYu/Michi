import React, { useEffect, useRef, useState } from 'react';
import { getElectron } from '../lib/electronBridge';
import type { FolderEntry } from '../state/chatTypes';
import { ModalShell } from './ui/ModalShell';
import { Button } from './ui/controls';

interface NewWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (workspaceName: string | undefined, cwd: string | undefined, folders?: FolderEntry[]) => void;
  /** Called when the user picks Skip — opens the singleton Chats workspace. */
  onSkip: () => void;
}

// showDirectoryPicker is not in the default TS lib; narrow type.
type DirectoryPicker = (opts?: { mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>;

const MAX_FOLDERS = 10;

function basename(p: string): string {
  return p.split('/').pop() || p;
}

/** Detect nesting between a candidate path and existing entries. */
function hasNesting(candidate: string, entries: FolderEntry[]): boolean {
  return entries.some(
    (f) =>
      candidate.startsWith(f.path + '/') ||
      candidate === f.path ||
      f.path.startsWith(candidate + '/'),
  );
}

// Shared styles
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
  const [folders, setFolders] = useState<FolderEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setFolders([]);
      setError(null);
      setFolderNotice(null);
    }
  }, [open]);

  if (!open) return null;

  const addFolder = async () => {
    if (folders.length >= MAX_FOLDERS) {
      setError(`Maximum ${MAX_FOLDERS} folders reached`);
      return;
    }
    setError(null);
    setFolderNotice(null);

    const electron = getElectron();
    if (electron?.chooseFolders) {
      const r = await electron.chooseFolders();
      if (r.canceled || r.folders.length === 0) return;
      const newEntries: FolderEntry[] = [];
      for (const picked of r.folders) {
        if (folders.length + newEntries.length >= MAX_FOLDERS) {
          setError(`Maximum ${MAX_FOLDERS} folders reached — some selections were skipped`);
          break;
        }
        const allCurrent = [...folders, ...newEntries];
        if (allCurrent.some((f) => f.path === picked.path)) continue; // dedupe
        if (hasNesting(picked.path, allCurrent)) {
          setError(`"${picked.name}" overlaps with an existing folder (nested or parent) — skipped`);
          continue;
        }
        newEntries.push({
          id: Math.random().toString(36).slice(2, 10),
          path: picked.path,
          label: picked.name,
          addedAt: Date.now(),
        });
      }
      if (newEntries.length > 0) {
        setFolders((prev) => [...prev, ...newEntries]);
      }
      return;
    }

    // Fallback: single-select chooseFolder (older Electron builds)
    if (electron?.chooseFolder) {
      const r = await electron.chooseFolder();
      if (r.canceled || !r.path) return;
      if (hasNesting(r.path, folders)) {
        setError('This folder overlaps with an existing folder (nested or parent)');
        return;
      }
      if (folders.some((f) => f.path === r.path)) {
        setError('This folder is already added');
        return;
      }
      const entry: FolderEntry = {
        id: Math.random().toString(36).slice(2, 10),
        path: r.path,
        label: r.name,
        addedAt: Date.now(),
      };
      setFolders((prev) => [...prev, entry]);
      return;
    }

    // Browser fallback: showDirectoryPicker
    const pick = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
    if (pick) {
      try {
        const handle = await pick();
        const entry: FolderEntry = {
          id: Math.random().toString(36).slice(2, 10),
          path: handle.name, // Browser can only get the name
          label: handle.name,
          addedAt: Date.now(),
        };
        setFolders((prev) => [...prev, entry]);
        setFolderNotice(
          'Browsers cannot link absolute local folders. Use the desktop app for full filesystem access.',
        );
        return;
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setError('Could not read that folder.');
        return;
      }
    }
    fallbackInputRef.current?.click();
  };

  const removeFolder = (id: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== id));
  };

  const makePrimary = (id: string) => {
    setFolders((prev) => {
      const idx = prev.findIndex((f) => f.id === id);
      if (idx <= 0) return prev;
      const target = prev[idx];
      const rest = prev.filter((_, i) => i !== idx);
      return [target, ...rest];
    });
  };

  const onFallbackChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const relPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    if (relPath) {
      const first = relPath.split('/')[0];
      if (first) {
        const entry: FolderEntry = {
          id: Math.random().toString(36).slice(2, 10),
          path: first,
          label: first,
          addedAt: Date.now(),
        };
        setFolders((prev) => [...prev, entry]);
        setFolderNotice(
          'Browsers cannot link absolute local folders. Use the desktop app for full filesystem access.',
        );
      }
    }
    e.target.value = '';
  };

  const trimmedName = name.trim();
  const primaryFolder = folders[0];
  const finalName = trimmedName || (primaryFolder ? basename(primaryFolder.path) : undefined);
  const hasFolders = folders.length > 0;

  const handleCreate = () => {
    const cwd = primaryFolder?.path ?? undefined;
    onCreate(finalName, cwd, folders.length > 0 ? folders : undefined);
  };

  return (
    <ModalShell open={open} onClose={onClose} title="New workspace" titleGlyph="▸" width={480}>
      {/* Name row */}
      <div style={PROMPT_ROW}>
        <span style={PROMPT_GLYPH} aria-hidden>›_</span>
        <span style={PROMPT_LABEL}>name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={primaryFolder ? basename(primaryFolder.path) : 'untitled workspace'}
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

      {/* Folders section */}
      <div style={{ borderBottom: '1px solid var(--term-line)', background: 'var(--term-surface)' }}>
        <div style={{ padding: '10px 14px 6px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={PROMPT_GLYPH} aria-hidden>›_</span>
          <span style={{ ...PROMPT_LABEL, width: 'auto' }}>source folders</span>
        </div>

        {!hasFolders ? (
          /* Empty state — big clickable area */
          <button
            type="button"
            onClick={() => { void addFolder(); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              width: 'calc(100% - 28px)',
              margin: '0 14px 12px',
              padding: '18px 14px',
              border: '1.5px dashed var(--term-line)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--term-mid)',
              fontFamily: 'var(--ui-font)',
              fontSize: 13,
              cursor: 'pointer',
              transition: 'border-color 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--term-accent)';
              e.currentTarget.style.color = 'var(--term-fg)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--term-line)';
              e.currentTarget.style.color = 'var(--term-mid)';
            }}
          >
            <FolderPlusIcon />
            Add folders the agent can read and edit
          </button>
        ) : (
          /* Folder list */
          <div style={{ padding: '0 14px 8px' }}>
            {folders.map((f, idx) => (
              <FolderRow
                key={f.id}
                folder={f}
                isPrimary={idx === 0}
                onRemove={() => removeFolder(f.id)}
                onMakePrimary={() => makePrimary(f.id)}
              />
            ))}
            {folders.length < MAX_FOLDERS && (
              <button
                type="button"
                onClick={() => { void addFolder(); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  marginTop: 6,
                  padding: '5px 8px',
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--term-mid)',
                  fontFamily: 'var(--ui-font)',
                  fontSize: 11.5,
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: 13 }}>+</span> Add folder
              </button>
            )}
          </div>
        )}
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
          {folderNotice}
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
        <Button variant="primary" onClick={handleCreate}>create</Button>
      </div>
    </ModalShell>
  );
}

/* ---------- Folder row ---------- */

interface FolderRowProps {
  folder: FolderEntry;
  isPrimary: boolean;
  onRemove: () => void;
  onMakePrimary: () => void;
}

function FolderRow({ folder, isPrimary, onRemove, onMakePrimary }: FolderRowProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 4,
        background: hovered ? 'var(--term-alt)' : 'transparent',
        transition: 'background 0.1s',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FolderIcon />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--term-fg)',
            fontFamily: 'var(--ui-font)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {folder.label || basename(folder.path)}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--term-muted)',
            fontFamily: 'var(--mono-font, monospace)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={folder.path}
        >
          {folder.path}
        </div>
      </div>

      {isPrimary && (
        <span
          style={{
            fontSize: 10,
            fontFamily: 'var(--ui-font)',
            fontWeight: 600,
            color: 'var(--term-accent)',
            background: 'color-mix(in srgb, var(--term-accent) 12%, transparent)',
            padding: '2px 6px',
            borderRadius: 3,
            flexShrink: 0,
          }}
        >
          Primary
        </span>
      )}

      {!isPrimary && hovered && (
        <button
          type="button"
          onClick={onMakePrimary}
          title="Make this the working directory"
          style={{
            fontSize: 10,
            fontFamily: 'var(--ui-font)',
            color: 'var(--term-mid)',
            background: 'transparent',
            border: '1px solid var(--term-line)',
            padding: '2px 6px',
            borderRadius: 3,
            cursor: 'pointer',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          Make primary
        </button>
      )}

      <button
        type="button"
        onClick={onRemove}
        title="Remove folder"
        style={{
          background: 'transparent',
          border: 'none',
          color: hovered ? 'var(--term-fg)' : 'transparent',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: '2px 4px',
          flexShrink: 0,
          transition: 'color 0.1s',
        }}
      >
        ×
      </button>
    </div>
  );
}

/* ---------- Icons ---------- */

function FolderPlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    >
      <path d="M2 4h4l1.5 1.5H14v8H2z" />
      <path d="M8 7.5v4M6 9.5h4" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--term-muted)"
      strokeWidth="1.3"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M2 4h4l1.5 1.5H14v8H2z" />
    </svg>
  );
}
