import React, { useState } from 'react';
import { toast } from 'sonner';
import { getElectron } from '../../../lib/electronBridge';
import type { FolderEntry } from '../../../state/chatTypes';

interface Props {
  folders: FolderEntry[];
  projectId: string;
  onAddFolder: (projectId: string, path: string, label?: string) => void;
  onRemoveFolder: (projectId: string, folderId: string) => void;
  onUpdateLabel: (projectId: string, folderId: string, label: string) => void;
}

const MAX_FOLDERS = 10;

function basename(p: string): string {
  return p.split('/').pop() || p;
}

export default function FolderList({
  folders,
  projectId,
  onAddFolder,
  onRemoveFolder,
  onUpdateLabel,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const handleAdd = async () => {
    if (folders.length >= MAX_FOLDERS) {
      toast.error(`Maximum ${MAX_FOLDERS} folders reached`);
      return;
    }
    const electron = getElectron();

    // Prefer multi-select picker when available
    if (electron?.chooseFolders) {
      try {
        const result = await electron.chooseFolders();
        if (result.canceled || result.folders.length === 0) return;
        let added = 0;
        for (const picked of result.folders) {
          if (folders.length + added >= MAX_FOLDERS) {
            toast.error(`Maximum ${MAX_FOLDERS} folders reached — some selections were skipped`);
            break;
          }
          // Dedupe and nesting are enforced by the store's addFolder action
          onAddFolder(projectId, picked.path, picked.name);
          added++;
        }
      } catch (err) {
        toast.error(`Failed to add folder: ${(err as Error).message}`);
      }
      return;
    }

    // Fallback: single-select chooseFolder (older Electron builds)
    if (electron?.chooseFolder) {
      try {
        const result = await electron.chooseFolder();
        if (!result.canceled && result.path) {
          onAddFolder(projectId, result.path, result.name);
        }
      } catch (err) {
        toast.error(`Failed to add folder: ${(err as Error).message}`);
      }
      return;
    }

    // Browser fallback: showDirectoryPicker
    try {
      const handle = await (window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> })
        .showDirectoryPicker();
      if (handle?.name) {
        toast.info('Browser mode: folder path may be incomplete. Use the desktop app for full path access.');
        onAddFolder(projectId, handle.name);
      }
    } catch {
      // User cancelled
    }
  };

  const beginEdit = (f: FolderEntry) => {
    setEditingId(f.id);
    setDraft(f.label || basename(f.path));
  };

  const commitEdit = (folderId: string) => {
    const trimmed = draft.trim();
    if (trimmed) {
      onUpdateLabel(projectId, folderId, trimmed);
    }
    setEditingId(null);
  };

  return (
    <div style={{ marginTop: 10 }}>
      {folders.map((f, idx) => (
        <div
          key={f.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 0',
            borderBottom: idx < folders.length - 1 ? '1px solid var(--term-line)' : undefined,
          }}
        >
          {/* Lock icon for first (cwd) folder */}
          {idx === 0 ? (
            <LockIcon />
          ) : (
            <span style={{ width: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <FolderIcon />
            </span>
          )}

          <div style={{ flex: 1, minWidth: 0 }}>
            {editingId === f.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitEdit(f.id);
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={() => commitEdit(f.id)}
                style={{
                  width: '100%',
                  fontSize: 12,
                  fontFamily: 'var(--ui-font)',
                  background: 'var(--term-alt)',
                  border: '1px solid var(--term-line)',
                  color: 'var(--term-fg)',
                  padding: '1px 4px',
                  outline: 'none',
                }}
              />
            ) : (
              <>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--term-fg)',
                    fontFamily: 'var(--ui-font)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    cursor: idx > 0 ? 'pointer' : 'default',
                  }}
                  onClick={() => idx > 0 && beginEdit(f)}
                  title={idx > 0 ? 'Click to rename' : undefined}
                >
                  {f.label || basename(f.path)}
                  {idx === 0 && (
                    <span style={{
                      fontSize: 10,
                      color: 'var(--term-muted)',
                      marginLeft: 6,
                      fontWeight: 400,
                    }}>
                      (working directory)
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: 'var(--term-faint, var(--term-muted))',
                    fontFamily: 'var(--mono-font, monospace)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={f.path}
                >
                  {f.path}
                </div>
              </>
            )}
          </div>

          {/* Delete button (not for index 0) */}
          {idx > 0 && editingId !== f.id && (
            <button
              type="button"
              onClick={() => onRemoveFolder(projectId, f.id)}
              title="Remove folder"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--term-muted)',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: '2px 4px',
                flexShrink: 0,
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}

      {/* Add folder button */}
      <button
        type="button"
        onClick={() => { void handleAdd(); }}
        disabled={folders.length >= MAX_FOLDERS}
        style={{
          marginTop: 8,
          width: '100%',
          padding: '5px 10px',
          fontFamily: 'var(--ui-font)',
          fontSize: 11,
          color: folders.length >= MAX_FOLDERS ? 'var(--term-muted)' : 'var(--term-fg)',
          background: 'transparent',
          border: '1px dashed var(--term-line)',
          cursor: folders.length >= MAX_FOLDERS ? 'default' : 'pointer',
          opacity: folders.length >= MAX_FOLDERS ? 0.5 : 1,
        }}
      >
        + Add folder{folders.length >= MAX_FOLDERS ? ` (limit: ${MAX_FOLDERS})` : ''}
      </button>
    </div>
  );
}

function LockIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--term-muted)"
      strokeWidth="1.4"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-label="locked"
    >
      <rect x="3" y="7" width="10" height="7" rx="1" />
      <path d="M5 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--term-muted)"
      strokeWidth="1.3"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-label="folder"
    >
      <path d="M2 4h4l1.5 1.5H14v8H2z" />
    </svg>
  );
}
