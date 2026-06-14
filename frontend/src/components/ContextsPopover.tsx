import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../state/chatStore';
import type { ContextEntry } from '../state/chatStore';
import { buildContextRowMenu } from '../lib/contextRowContextMenu';
import ContextMenu from './ContextMenu';
import type { MenuSection } from './ContextMenu';
import { PopoverSurface } from './ui/Popover';
import { importWorkspaceFileUpload, type UploadProgress } from '../services/api';
import { getElectron } from '../lib/electronBridge';
import { relativeTime } from '../lib/relativeTime';
import { sanitizeContextName } from '../lib/sanitizeContextName';
import UploadProgressBar, { type UploadProgressViewState } from './UploadProgressBar';

const POPOVER_WIDTH = 340;

function fileTypeLabel(filePath: string): string {
  const ext = filePath.toLowerCase().match(/\.([^./\\]+)$/)?.[1] ?? '';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'md';
  if (ext === 'txt' || ext === 'log' || ext === 'rtf') return 'txt';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'xls' || ext === 'xlsx' || ext === 'xlsm') return 'xls';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'doc' || ext === 'docx') return 'doc';
  if (ext === 'ppt' || ext === 'pptx' || ext === 'key') return 'ppt';
  if (['json', 'yaml', 'yml', 'toml'].includes(ext)) return ext;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'rb', 'sh'].includes(ext)) return ext;
  if (['cpp', 'cc', 'hpp', 'hh', 'cxx'].includes(ext)) return 'cpp';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif'].includes(ext)) return 'img';
  if (['html', 'htm', 'xml'].includes(ext)) return 'html';
  return ext.slice(0, 3) || '·';
}

export interface ContextsPopoverProps {
  anchorRect: DOMRect;
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

export default function ContextsPopover({ anchorRect, anchorEl, onClose }: ContextsPopoverProps) {
  const {
    activeProject,
    createContext,
    updateContext,
    deleteContext,
    toggleAutoInject,
  } = useChatStore();

  const popoverRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressViewState | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; ctx: ContextEntry } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const contexts = useMemo(() => activeProject?.contexts ?? [], [activeProject]);
  const cwd = activeProject?.cwd;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const root = popoverRef.current;
      if (!root) return;
      const target = e.target as Node;
      if (root.contains(target)) return;
      if (anchorEl && anchorEl.contains(target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose, anchorEl]);

  const handleOpen = useCallback((ctx: ContextEntry) => {
    const electron = getElectron();
    if (!electron?.openPath) return;
    const abs = ctx.kind === 'reference' || ctx.filePath.startsWith('/')
      ? ctx.filePath
      : cwd ? `${cwd.replace(/\/$/, '')}/${ctx.filePath}` : null;
    if (!abs) return;
    void electron.openPath(abs).then((r) => {
      if (!r.ok && r.error) console.warn(`openPath(${abs}) failed:`, r.error);
    });
  }, [cwd]);

  const handleStartRename = useCallback((ctx: ContextEntry) => {
    setRenameTarget(ctx.id);
    setRenameDraft(ctx.name);
  }, []);

  const handleAdd = useCallback(async () => {
    if (importing) return;
    setImportError(null);
    const electron = getElectron();
    if (electron?.chooseFiles) {
      setImporting(true);
      try {
        const r = await electron.chooseFiles();
        if (!r.canceled && r.paths) {
          const existing = contexts.map((c) => c.name);
          for (const p of r.paths) {
            const base = p.split('/').pop() ?? p;
            const name = sanitizeContextName(base, existing);
            existing.push(name);
            createContext(name, p, { kind: 'reference' });
          }
        }
      } catch (err) {
        setImportError((err as Error).message);
      } finally {
        setImporting(false);
      }
      return;
    }
    fileInputRef.current?.click();
  }, [importing, contexts, createContext]);

  const progressForFile = useCallback(
    (fileName: string, fileIndex: number, fileCount: number) =>
      (progress: UploadProgress) => {
        setUploadProgress({
          fileName,
          fileIndex,
          fileCount,
          phase: progress.phase,
          percent: progress.percent,
        });
      },
    [],
  );

  const handleWebFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!activeProject?.id) {
      setImportError('No active workspace');
      return;
    }
    if (!cwd) {
      setImportError('Workspace has no folder set');
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const fileArray = Array.from(files);
      for (const [fileIndex, file] of fileArray.entries()) {
        const result = await importWorkspaceFileUpload(activeProject.id, cwd, file, {
          onProgress: progressForFile(file.name, fileIndex, fileArray.length),
        });
        createContext(result.name, result.filePath, { size: result.size });
      }
    } catch (err) {
      setImportError((err as Error).message);
    } finally {
      setImporting(false);
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [activeProject?.id, cwd, createContext, progressForFile]);

  const menuSections = useMemo((): MenuSection[] => {
    if (!menu) return [];
    const items = buildContextRowMenu({
      context: menu.ctx,
      onToggleAutoInject: () => toggleAutoInject(menu.ctx.id),
      onRename: () => handleStartRename(menu.ctx),
      onDelete: () => {
        if (window.confirm(`Delete context "${menu.ctx.name}"?`)) {
          deleteContext(menu.ctx.id);
        }
      },
    });
    return [{
      items: items.map((it, i) => ({
        id: `ctx-${i}`,
        label: it.label,
        keys: it.keys,
        run: it.action,
        danger: it.danger,
      })),
    }];
  }, [menu, toggleAutoInject, handleStartRename, deleteContext]);

  if (!activeProject) return null;

  const left = Math.max(8, Math.min(window.innerWidth - POPOVER_WIDTH - 8, anchorRect.right - POPOVER_WIDTH));
  const top = anchorRect.bottom + 6;

  return (
    <PopoverSurface
      ref={popoverRef}
      left={left}
      top={top}
      width={POPOVER_WIDTH}
      maxHeight="60vh"
      role="dialog"
      aria-label="Contexts"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 12px',
          borderBottom: '1px solid var(--term-line)',
          color: 'var(--term-mid)',
          letterSpacing: '.12em',
          fontSize: 10,
        }}
      >
        <span style={{ flex: 1 }}>▸ CONTEXTS · {contexts.length}</span>
        <button
          type="button"
          title={importing ? 'Importing…' : 'Add context file'}
          aria-label="Add context"
          onClick={handleAdd}
          disabled={importing}
          style={{
            cursor: importing ? 'wait' : 'pointer',
            color: 'var(--term-mid)',
            fontWeight: 700,
            fontSize: 14,
            opacity: importing ? 0.5 : 1,
            padding: '0 4px',
            background: 'transparent',
            border: 'none',
            fontFamily: 'inherit',
          }}
        >
          {importing ? '…' : '+'}
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={(e) => handleWebFiles(e.target.files)}
        style={{ display: 'none' }}
      />

      {importError && (
        <div style={{ padding: '4px 12px', fontSize: 10, color: 'var(--term-danger)' }}>
          {importError}
        </div>
      )}

      <UploadProgressBar progress={uploadProgress} compact />

      {contexts.length === 0 && !importError && (
        <div style={{ padding: '18px 12px', fontSize: 11, color: 'var(--term-faint)', fontStyle: 'italic', textAlign: 'center' }}>
          — no contexts yet · drop a file or click +
        </div>
      )}

      {contexts.map((ctx) => {
        const isRenaming = renameTarget === ctx.id;
        return (
          <div
            key={ctx.id}
            className="t-context-row-hover"
            title={ctx.filePath}
            onClick={() => { if (!isRenaming) handleOpen(ctx); }}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, ctx });
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 12px',
              cursor: 'pointer',
              color: 'var(--term-fg)',
              fontSize: 11.5,
              fontFamily: 'var(--ui-font)',
            }}
          >
            <span style={{ fontSize: 9, fontFamily: 'var(--ui-font)', color: 'var(--term-muted)', flexShrink: 0, width: 26, textAlign: 'left', letterSpacing: '.04em' }}>
              {fileTypeLabel(ctx.filePath)}
            </span>
            {ctx.autoInject ? (
              <span title="auto-inject" style={{ fontSize: 10, color: 'var(--term-accent)', flexShrink: 0 }}>⚡</span>
            ) : (
              <span style={{ width: 10, flexShrink: 0 }} />
            )}
            {isRenaming ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const v = renameDraft.trim();
                    if (v && /^[\p{L}\p{N}_-]+$/u.test(v)) updateContext(ctx.id, { name: v });
                    setRenameTarget(null);
                  } else if (e.key === 'Escape') {
                    setRenameTarget(null);
                  }
                }}
                onBlur={() => setRenameTarget(null)}
                onClick={(e) => e.stopPropagation()}
                style={{ flex: 1, fontSize: 11, background: 'transparent', border: '1px solid var(--term-line)', color: 'var(--term-fg)' }}
              />
            ) : (
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ctx.name}
              </span>
            )}
            {ctx.kind === 'reference' && (
              <span title="external reference" style={{ fontSize: 11, color: 'var(--term-faint)', flexShrink: 0 }}>↗</span>
            )}
            {ctx.source === 'agent' && (
              <span style={{ fontSize: 9, color: 'var(--term-faint)', border: '1px solid var(--term-line)', padding: '0 4px', borderRadius: 2, flexShrink: 0 }}>
                agent
              </span>
            )}
            <span style={{ fontSize: 9.5, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', flexShrink: 0, width: 56, textAlign: 'right' }}>
              {relativeTime(ctx.updatedAt)}
            </span>
          </div>
        );
      })}

      {contexts.length > 0 && (
        <div style={{ padding: '8px 12px', color: 'var(--term-faint)', fontSize: 10, borderTop: '1px solid var(--term-line)', textAlign: 'center' }}>
          drop file on a pane to import &amp; insert <span style={{ color: 'var(--term-accent)', fontFamily: 'var(--ui-font)' }}>@</span>mention
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} sections={menuSections} onClose={() => setMenu(null)} />
      )}
    </PopoverSurface>
  );
}
