import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../../state/chatStore';
import type { ContextEntry } from '../../state/chatTypes';
import { sanitizeContextName } from '../../lib/sanitizeContextName';
import { getElectron } from '../../lib/electronBridge';
import { importWorkspaceFile } from '../../services/api';
import { relativeTime } from '../../lib/relativeTime';
import { Lightbox } from './Lightbox';
import { manageFileType } from './manage/tokens';
import ContextMenu from '../ContextMenu';
import type { MenuSection } from '../ContextMenu';

/**
 * 3a "Artifacts" sidebar — a right drawer (⌘⇧A) mirroring the Settings drawer
 * mechanism. Workspace-scoped, type-grouped (Documents / Files / Images /
 * Links), collapsible groups, newest-first within a group with favorite rows
 * floated to the top.
 *
 * Accordion: a row is a single dense line; clicking it expands metadata + an
 * action bar in place (open-in-pane / cite / favorite / delete). Only one row is
 * expanded at a time. Type-aware behavior:
 *   - doc   → open in a read-only pane (markdown)               [v1: OS opener]
 *   - file  → open via OS default app (no built-in viewer)
 *   - image → open in the Lightbox
 *   - link  → open the URL in the default browser
 * Path-missing liveness is reported lazily: opening a moved/broken file just
 * surfaces the OS/opener error — there's no pre-flight probe.
 */

type ArtifactType = 'doc' | 'file' | 'image' | 'link';

const TYPE_GROUPS: Array<{ key: ArtifactType; title: string }> = [
  { key: 'doc', title: 'Documents' },
  { key: 'file', title: 'Files' },
  { key: 'image', title: 'Images' },
  { key: 'link', title: 'Links' },
];

function artifactType(c: ContextEntry): ArtifactType {
  if (c.type) return c.type;
  return c.url ? 'link' : 'doc';
}

/** Host + trimmed path, for a compact link meta line. Falls back to the raw url. */
function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'avif']);

/** Classify a picked file path into an artifact type by extension. */
function typeForPath(path: string): 'doc' | 'file' | 'image' {
  const ext = path.toLowerCase().match(/\.([^./\\]+)$/)?.[1] ?? '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown' || ext === 'txt') return 'doc';
  return 'file';
}

export default function ArtifactsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    activeProject,
    focusedNodeId,
    createContext,
    updateContext,
    deleteContext,
    pinContext,
    openArtifactPane,
  } = useChatStore();

  const [filter, setFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<ArtifactType>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [pasteVal, setPasteVal] = useState('');
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; ctx: ContextEntry } | null>(null);

  const contexts = useMemo(() => activeProject?.contexts ?? [], [activeProject]);
  const cwd = activeProject?.cwd;

  const openInFolder = useCallback((c: ContextEntry) => {
    const electron = getElectron();
    if (!electron?.openPath) return;
    // Resolve to absolute, then open the parent directory.
    const abs =
      c.kind === 'reference' || c.filePath.startsWith('/')
        ? c.filePath
        : cwd
          ? `${cwd.replace(/\/$/, '')}/${c.filePath}`
          : null;
    if (!abs) return;
    const dir = abs.replace(/\/[^/]+$/, '') || '/';
    void electron.openPath(dir);
  }, [cwd]);

  const handleRename = useCallback((id: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || !/^[\p{L}\p{N}_-]+$/u.test(trimmed)) return;
    updateContext(id, { name: trimmed });
    setRenameId(null);
  }, [updateContext]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // Close the lightbox first if it's up; otherwise the drawer. The
      // Lightbox has its own Escape handler too, so guard against acting when
      // it's open by reading state directly (no side-effects in a setState
      // updater — that double-fires under StrictMode).
      if (lightbox) setLightbox(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, lightbox]);

  const filtered = useMemo(() => {
    const norm = filter.trim().toLowerCase();
    const rows = norm
      ? contexts.filter(
          (c) =>
            c.name.toLowerCase().includes(norm) ||
            c.filePath.toLowerCase().includes(norm) ||
            (c.url ?? '').toLowerCase().includes(norm),
        )
      : contexts;
    const byType = new Map<ArtifactType, ContextEntry[]>();
    for (const c of rows) {
      const t = artifactType(c);
      const arr = byType.get(t) ?? [];
      arr.push(c);
      byType.set(t, arr);
    }
    for (const arr of byType.values()) {
      arr.sort((a, b) => {
        if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
        return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      });
    }
    return byType;
  }, [contexts, filter]);

  const openArtifact = useCallback(
    (c: ContextEntry) => {
      const t = artifactType(c);
      console.log('[ArtifactsDrawer] openArtifact', { name: c.name, type: c.type, resolved: t, filePath: c.filePath });
      if (t === 'link') {
        if (c.url) window.open(c.url, '_blank', 'noopener,noreferrer');
        return;
      }
      if (t === 'image') {
        // Serve via the workspace image route. filePath may be workspace-rel
        // (.attachments/...) or absolute; the route resolves within cwd.
        if (activeProject?.id) {
          const rel = c.filePath.replace(/^\/+/, '');
          setLightbox({ src: `/api/files/${activeProject.id}/${rel}`, name: c.name });
        }
        return;
      }
      // doc → open in ArtifactPane (markdown viewer) if available
      if (t === 'doc') {
        const relPath = c.kind === 'reference' || c.filePath.startsWith('/')
          ? c.filePath
          : c.filePath;
        try {
          openArtifactPane(relPath);
          onClose();
        } catch (err) {
          // Fallback: open via OS if pane creation fails (e.g. no workspace cwd)
          console.warn('[ArtifactsDrawer] openArtifactPane failed, falling back to OS opener:', err);
          const electron = getElectron();
          if (!electron?.openPath) return;
          const abs = c.filePath.startsWith('/')
            ? c.filePath
            : cwd
              ? `${cwd.replace(/\/$/, '')}/${c.filePath}`
              : null;
          if (abs) void electron.openPath(abs);
        }
        return;
      }
      // file → hand off to the OS default app.
      const electron = getElectron();
      if (!electron?.openPath) return;
      const abs =
        c.kind === 'reference' || c.filePath.startsWith('/')
          ? c.filePath
          : cwd
            ? `${cwd.replace(/\/$/, '')}/${c.filePath}`
            : null;
      if (!abs) return;
      void electron.openPath(abs).then((r) => {
        if (!r.ok && r.error) console.warn(`openPath(${abs}) failed:`, r.error);
      });
    },
    [activeProject?.id, cwd, openArtifactPane, onClose],
  );

  // "Cite" — ask the focused pane to append @name to its composer. The pane
  // owns the live draft (text + mention offsets), so it merges the token and
  // resolveAtMentions injects the artifact on send. See TPane's
  // `michi:cite-artifact` listener.
  const cite = useCallback(
    (c: ContextEntry) => {
      if (!focusedNodeId) return;
      window.dispatchEvent(
        new CustomEvent('michi:cite-artifact', {
          detail: { nodeId: focusedNodeId, name: c.name },
        }),
      );
      onClose();
    },
    [focusedNodeId, onClose],
  );

  const handlePaste = useCallback(async () => {
    const raw = pasteVal.trim();
    if (!raw) return;
    setPasteErr(null);
    const existing = contexts.map((c) => c.name);
    const isUrl = /^https?:\/\//i.test(raw);
    if (isUrl) {
      // Link artifact — pure metadata, no cwd needed.
      let host = raw;
      try {
        host = new URL(raw).host;
      } catch {
        /* keep raw */
      }
      const name = sanitizeContextName(host || 'link', existing);
      createContext(name, '', { url: raw, type: 'link', source: 'user' });
      setPasteVal('');
      setAdding(false);
      return;
    }
    // Non-URL paste → save as a doc under .contexts/ (requires a cwd).
    if (!activeProject?.id || !cwd) {
      setPasteErr('Pasting text as a doc needs a workspace folder. Paste a URL to save a link.');
      return;
    }
    try {
      const stem = raw.split('\n', 1)[0].slice(0, 40) || 'note';
      const name = sanitizeContextName(stem, existing);
      const result = await importWorkspaceFile(activeProject.id, cwd, `${name}.md`, raw);
      createContext(result.name, result.filePath, { size: result.size, type: 'doc', kind: 'embedded', source: 'user' });
      setPasteVal('');
      setAdding(false);
    } catch (err) {
      setPasteErr((err as Error).message);
    }
  }, [pasteVal, contexts, activeProject?.id, cwd, createContext]);

  // Pick file(s) from disk → file/image reference artifacts (Electron only).
  // Mirrors the old Contexts "+" behavior; on web there's no native picker so
  // the button falls back to just toggling the paste bar.
  const handlePickFile = useCallback(async () => {
    const electron = getElectron();
    if (!electron?.chooseFiles) {
      setAdding((v) => !v);
      return;
    }
    setPasteErr(null);
    try {
      const r = await electron.chooseFiles();
      if (r.canceled || !r.paths) return;
      const existing = contexts.map((c) => c.name);
      for (const p of r.paths) {
        const base = p.split('/').pop() ?? p;
        const name = sanitizeContextName(base, existing);
        existing.push(name);
        createContext(name, p, { kind: 'reference', type: typeForPath(p), source: 'user' });
      }
    } catch (err) {
      setPasteErr((err as Error).message);
    }
  }, [contexts, createContext]);

  if (!open) return null;

  const total = contexts.length;

  return (
    <>
      <div
        onMouseDown={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'color-mix(in srgb, var(--term-bg) 22%, transparent)',
          zIndex: 39,
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      />
      <div
        className="terminal-settings-drawer term-glass"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 420,
          maxWidth: '50vw',
          borderLeft: 'var(--term-pane-divider, 1px solid var(--term-line))',
          borderTopLeftRadius: 'var(--term-pane-radius, 0px)',
          borderBottomLeftRadius: 'var(--term-pane-radius, 0px)',
          display: 'flex',
          flexDirection: 'column',
          zIndex: 40,
          animation: 'slideInRight 200ms ease-out both',
          // The drawer starts at top:0, overlapping the macOS hiddenInset
          // titlebar drag region (electron/main.ts). Without no-drag the OS
          // eats real clicks on the header (+, file, ×) as window-drags — which
          // is why they felt dead. Mirrors the Topbar's no-drag treatment.
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 14px',
            borderBottom: '1px solid var(--term-line)',
            background: 'transparent',
            WebkitAppRegion: 'no-drag',
          } as React.CSSProperties}
        >
          <span style={{ fontFamily: 'var(--ui-font)', fontSize: 11, letterSpacing: '.14em', color: 'var(--term-muted)' }}>
            ▸ ARTIFACTS
          </span>
          <span style={{ fontSize: 11, color: 'var(--term-faint)', fontFamily: 'var(--ui-font)' }}>{total}</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="ws-action-btn"
            onClick={handlePickFile}
            title="Add file from disk"
            aria-label="Add file"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <FileAddIcon />
          </button>
          <button
            type="button"
            className="ws-action-btn"
            onClick={() => setAdding((v) => !v)}
            title="Add link or paste text"
            aria-label="Add link or text"
            style={{ fontSize: 17, background: adding ? 'var(--term-alt)' : undefined, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            +
          </button>
          <button
            type="button"
            className="ws-action-btn"
            onClick={onClose}
            title="Close (esc)"
            aria-label="Close"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            ×
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--term-line)' }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search artifacts…"
            style={{
              width: '100%',
              background: 'var(--term-alt)',
              border: '1px solid var(--term-line)',
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              fontSize: 12,
              padding: '5px 8px',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Add bar (paste URL / text) */}
        {adding && (
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--term-line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <textarea
              autoFocus
              value={pasteVal}
              onChange={(e) => setPasteVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handlePaste();
                }
              }}
              placeholder="Paste a URL to save a link, or text to save a doc…  (⌘↵)"
              rows={2}
              style={{
                width: '100%',
                background: 'var(--term-alt)',
                border: '1px solid var(--term-line)',
                color: 'var(--term-fg)',
                fontFamily: 'var(--ui-font)',
                fontSize: 12,
                padding: '5px 8px',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />
            {pasteErr && <div style={{ fontSize: 10.5, color: 'var(--term-danger)' }}>{pasteErr}</div>}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => { setAdding(false); setPasteVal(''); setPasteErr(null); }}
                style={btnGhost}
              >
                Cancel
              </button>
              <button type="button" onClick={() => void handlePaste()} style={btnSolid}>
                Save
              </button>
            </div>
          </div>
        )}

        {/* Groups */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {total === 0 && (
            <div style={{ padding: '24px 14px', fontSize: 12, color: 'var(--term-faint)', fontStyle: 'italic', textAlign: 'center' }}>
              — no artifacts yet · paste a URL or drop a file
            </div>
          )}
          {TYPE_GROUPS.map((g) => {
            const rows = filtered.get(g.key) ?? [];
            if (rows.length === 0) return null;
            const isCollapsed = collapsed.has(g.key);
            return (
              <section key={g.key}>
                <div
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(g.key)) next.delete(g.key);
                      else next.add(g.key);
                      return next;
                    })
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                    cursor: 'pointer',
                    color: 'var(--term-muted)',
                    fontFamily: 'var(--ui-font)',
                    fontSize: 10.5,
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                    borderBottom: '1px solid color-mix(in srgb, var(--term-line) 50%, transparent)',
                  }}
                >
                  <span style={{ width: 8, display: 'inline-block' }}>{isCollapsed ? '▸' : '▾'}</span>
                  <span>{g.title}</span>
                  <span style={{ color: 'var(--term-faint)' }}>· {rows.length}</span>
                </div>
                {!isCollapsed &&
                  rows.map((c) => (
                    <ArtifactRow
                      key={c.id}
                      c={c}
                      expanded={expandedId === c.id}
                      renaming={renameId === c.id}
                      renameDraft={renameId === c.id ? renameDraft : ''}
                      onRenameDraftChange={setRenameDraft}
                      onRenameCommit={() => handleRename(c.id, renameDraft)}
                      onRenameCancel={() => setRenameId(null)}
                      onToggle={() => setExpandedId((cur) => (cur === c.id ? null : c.id))}
                      onOpen={() => openArtifact(c)}
                      onCite={focusedNodeId ? () => cite(c) : undefined}
                      onPin={() => pinContext(c.id)}
                      onRename={() => { setRenameId(c.id); setRenameDraft(c.name); }}
                      onOpenInFolder={artifactType(c) !== 'link' ? () => openInFolder(c) : undefined}
                      onDelete={() => {
                        if (window.confirm(`Delete artifact "${c.name}"?`)) deleteContext(c.id);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setCtxMenu({ x: e.clientX, y: e.clientY, ctx: c });
                      }}
                    />
                  ))}
              </section>
            );
          })}
        </div>
      </div>

      {lightbox && (
        <Lightbox src={lightbox.src} filename={lightbox.name} onClose={() => setLightbox(null)} />
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          sections={[{
            items: [
              ...(artifactType(ctxMenu.ctx) !== 'link' ? [{
                id: 'open-folder',
                label: 'Open in Folder',
                keys: 'F',
                run: () => { openInFolder(ctxMenu.ctx); setCtxMenu(null); },
              }] : []),
              {
                id: 'rename',
                label: 'Rename',
                keys: 'R',
                run: () => { setRenameId(ctxMenu.ctx.id); setRenameDraft(ctxMenu.ctx.name); setCtxMenu(null); },
              },
              {
                id: 'delete',
                label: 'Delete',
                keys: 'D',
                danger: true,
                run: () => {
                  if (window.confirm(`Delete artifact "${ctxMenu.ctx.name}"?`)) deleteContext(ctxMenu.ctx.id);
                  setCtxMenu(null);
                },
              },
            ],
          }]}
        />
      )}
    </>
  );
}

function ArtifactRow({
  c,
  expanded,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onToggle,
  onOpen,
  onCite,
  onPin,
  onRename,
  onOpenInFolder,
  onDelete,
  onContextMenu,
}: {
  c: ContextEntry;
  expanded: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onToggle: () => void;
  onOpen: () => void;
  onCite?: () => void;
  onPin: () => void;
  onRename: () => void;
  onOpenInFolder?: () => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const t = artifactType(c);
  const isLink = t === 'link';
  const ft = isLink ? { label: 'url', color: '#0b6cb6' } : manageFileType(c.name);

  return (
    <div
      style={{ borderBottom: '1px solid color-mix(in srgb, var(--term-line) 35%, transparent)' }}
      onContextMenu={onContextMenu}
    >
      {/* Dense single-line row */}
      <div
        onClick={renaming ? undefined : onToggle}
        onDoubleClick={renaming ? undefined : onOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 12px',
          cursor: renaming ? 'default' : 'pointer',
          background: expanded ? 'var(--term-alt)' : 'transparent',
          fontFamily: 'var(--ui-font)',
          fontSize: 12,
          color: 'var(--term-fg)',
        }}
      >
        <span style={{ width: 26, fontSize: 9, color: ft.color, letterSpacing: '.04em', flexShrink: 0, textTransform: 'uppercase' }}>
          {ft.label}
        </span>
        {c.source === 'agent' && (
          <span title="agent-created" style={{ width: 5, height: 5, borderRadius: 99, background: '#6d4aa8', flexShrink: 0 }} />
        )}
        {c.pinnedAt && (
          <span title="favorite" style={{ fontSize: 10, color: 'var(--term-accent)', flexShrink: 0 }}>★</span>
        )}
        {renaming ? (
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => onRenameDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit();
              else if (e.key === 'Escape') onRenameCancel();
            }}
            onBlur={onRenameCancel}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              fontSize: 12,
              fontFamily: 'var(--ui-font)',
              background: 'var(--term-alt)',
              border: '1px solid var(--term-accent)',
              color: 'var(--term-fg)',
              padding: '1px 4px',
              minWidth: 0,
            }}
          />
        ) : (
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
        )}
        {!renaming && (
          <span style={{ fontSize: 9.5, color: 'var(--term-muted)', flexShrink: 0 }}>{relativeTime(c.updatedAt)}</span>
        )}
      </div>

      {/* Expanded metadata + action bar */}
      {expanded && !renaming && (
        <div style={{ padding: '2px 12px 10px 38px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--term-faint)', fontFamily: 'var(--ui-font)', wordBreak: 'break-all' }}>
            {isLink ? linkLabel(c.url ?? '') : `${c.kind === 'reference' ? '↗ ' : ''}${c.filePath}`}
          </div>
          {c.origin?.nodeId && (
            <div style={{ fontSize: 10.5, color: 'var(--term-faint)', fontFamily: 'var(--ui-font)' }}>
              from thread · {c.origin.nodeId.slice(0, 8)}
            </div>
          )}
          {isLink && (
            <div style={{ fontSize: 10, color: 'var(--term-muted)', fontStyle: 'italic' }}>
              Injected as <code>[Link: …]</code> — the agent won't auto-fetch it.
            </div>
          )}
          <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
            <button type="button" onClick={onOpen} style={btnAction}>
              {isLink ? 'Open ↗' : 'Open'}
            </button>
            {onOpenInFolder && (
              <button type="button" onClick={onOpenInFolder} style={btnAction}>
                Open in Folder
              </button>
            )}
            {onCite && (
              <button type="button" onClick={onCite} style={btnAction}>
                Cite
              </button>
            )}
            <button type="button" onClick={onRename} style={btnAction}>
              Rename
            </button>
            <button type="button" onClick={onPin} style={btnAction}>
              {c.pinnedAt ? 'Remove from favorites' : 'Add to favorites'}
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={onDelete} style={{ ...btnAction, color: 'var(--term-danger)' }}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const btnAction: React.CSSProperties = {
  border: '1px solid var(--term-line)',
  background: 'transparent',
  color: 'var(--term-mid)',
  fontFamily: 'var(--ui-font)',
  fontSize: 11,
  padding: '3px 8px',
  cursor: 'pointer',
};


function FileAddIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
      <path d="M3 2.5h6l4 4v7H3v-11z" />
      <path d="M9 2.5v4h4" />
      <path d="M8 8.5v3M6.5 10h3" />
    </svg>
  );
}

const btnGhost: React.CSSProperties = {
  border: '1px solid var(--term-line)',
  background: 'transparent',
  color: 'var(--term-mid)',
  fontFamily: 'var(--ui-font)',
  fontSize: 11.5,
  padding: '4px 10px',
  cursor: 'pointer',
};

const btnSolid: React.CSSProperties = {
  border: 'none',
  background: 'var(--term-fg)',
  color: 'var(--term-bg, #fff)',
  fontFamily: 'var(--ui-font)',
  fontSize: 11.5,
  fontWeight: 500,
  padding: '4px 12px',
  cursor: 'pointer',
};
