import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Clock3, Ellipsis, Folder, MessageSquare, Search, Trash2, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useChatStore, useChatNodesSnapshot } from '../../../state/chatStore';
import { usePrefs } from '../../../state/prefs';
import type { PageId } from '../../../state/commands';
import { pageBackground } from '../../../lib/pageBackground';
import { workspaceAccent } from '../workspaceAccent';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { Button } from '../../ui/controls';
import { TrashHighlight, TrashIconButton, TrashMenu } from './TrashControls';
import { TrashPreview } from './TrashPreview';
import { buildTrashSections, entryDeletedAt, entryKey, entryTitle, filterTrashSections, plural, relativeDeletion, remainingDays, trashItemCount, type TrashEntry } from './trashModel';
import './Trash.css';

export default function TerminalTrash({ onNav }: { onNav?: (page: PageId) => void } = {}) {
  const { projects, hydrated, restoreDeletion, purgeDeletionAsync, emptyTrashAsync, openPane, restoreProject, purgeProject, selectProject } = useChatStore();
  const nodes = useChatNodesSnapshot();
  const { prefs } = usePrefs();
  const ttl = prefs.trashTTLDays;
  const [query, setQuery] = useState('');
  const [oldestFirst, setOldestFirst] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(new Set());
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLButtonElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const operation = useRef(false);
  const mounted = useRef(true);
  const page = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const previewTrigger = useRef<HTMLElement | null>(null);
  const focusFrame = useRef<number>();

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => { mounted.current = false; clearInterval(timer); if (focusFrame.current) cancelAnimationFrame(focusFrame.current); };
  }, []);
  const sections = useMemo(() => buildTrashSections(projects, nodes), [projects, nodes]);
  const filtered = useMemo(() => filterTrashSections(sections, query, oldestFirst), [sections, query, oldestFirst]);
  const total = trashItemCount(sections);
  const resultCount = trashItemCount(filtered);
  const liveSections = filtered.filter(section => !section.project.deletedAt);
  const deletedSections = filtered.filter(section => section.project.deletedAt);
  const entries = useMemo(() => new Map(sections.flatMap(section => {
    const result: Array<[string, TrashEntry]> = section.groups.map(group => {
      const entry: TrashEntry = { kind: 'thread', project: section.project, group };
      return [entryKey(entry), entry];
    });
    if (section.project.deletedAt) {
      const entry: TrashEntry = { kind: 'workspace', ...section };
      result.push([entryKey(entry), entry]);
    }
    return result;
  })), [sections]);
  const preview = previewKey ? entries.get(previewKey) : undefined;
  const menuEntry = menu ? entries.get(menu.key) : undefined;
  const activeCollapsed = query.trim() ? searchCollapsed : collapsed;

  const focusNearby = (key?: string) => {
    const rowButtons = Array.from(page.current?.querySelectorAll<HTMLButtonElement>('[data-trash-open]') ?? []);
    const index = Math.max(0, rowButtons.findIndex(button => button.dataset.trashOpen === key));
    const nextKeys = [...rowButtons.slice(index + 1), ...rowButtons.slice(0, index).reverse()].map(button => button.dataset.trashOpen);
    return () => {
      focusFrame.current = requestAnimationFrame(() => {
        if (!mounted.current) return;
        const buttons = Array.from(page.current?.querySelectorAll<HTMLButtonElement>('[data-trash-open]') ?? []);
        const next = nextKeys.map(candidate => buttons.find(button => button.dataset.trashOpen === candidate)).find(Boolean);
        (next ?? buttons[0] ?? search.current)?.focus({ preventScroll: true });
      });
    };
  };
  const showPreview = (entry: TrashEntry) => {
    if (!previewKey) previewTrigger.current = document.activeElement as HTMLElement;
    setMenu(null);
    setPreviewKey(entryKey(entry));
  };
  const closePreview = () => {
    setPreviewKey(null);
    focusFrame.current = requestAnimationFrame(() => {
      if (previewTrigger.current?.isConnected) previewTrigger.current.focus({ preventScroll: true });
    });
  };
  const restore = (entry: TrashEntry) => {
    if (operation.current) return;
    const refocus = focusNearby(entryKey(entry));
    if (entry.project.deletedAt) restoreProject(entry.project.id);
    const root = entry.kind === 'thread' ? restoreDeletion(entry.group.id) : null;
    setPreviewKey(null);
    setMenu(null);
    setError(null);
    toast.success(entry.kind === 'thread' ? 'Thread restored' : 'Workspace restored', {
      ...(onNav ? { action: { label: 'Open', onClick: () => { selectProject(entry.project.id); if (root) openPane(root); onNav('dashboard'); } } } : {}),
    });
    refocus();
  };
  const purge = async (entry?: TrashEntry) => {
    if (operation.current) return;
    const trigger = previewKey ? previewTrigger.current : document.activeElement as HTMLElement | null;
    let returnFocus = false;
    // Guard the confirmation as well as the request: persistence only has one pause gate.
    operation.current = true;
    setBusy(true);
    setMenu(null);
    const refocus = focusNearby(entry && entryKey(entry));
    const title = entry ? entryTitle(entry) : '';
    const message = entry
      ? `Permanently delete ${entry.kind} "${title}"${entry.kind === 'workspace' ? ' and all of its contents' : ` (${plural(entry.group.members.length, 'node')})`}? This cannot be undone.`
      : `Permanently delete all ${plural(total, 'item')} in Trash, including the contents of deleted workspaces? This cannot be undone.`;
    // Avoid two simultaneous modal focus traps when deleting from a preview.
    const reopenPreview = previewKey;
    setPreviewKey(null);
    try {
      const confirmed = await confirmDialog({ title: entry ? 'Delete permanently?' : 'Empty trash?', message, confirmLabel: entry ? 'Delete permanently' : 'Empty trash' });
      if (!confirmed || !mounted.current) {
        if (mounted.current && reopenPreview) setPreviewKey(reopenPreview);
        else returnFocus = true;
        return;
      }
      setError(null);
      if (entry?.kind === 'thread') await purgeDeletionAsync(entry.group.id);
      else if (entry?.kind === 'workspace') await purgeProject(entry.project.id);
      else {
        // Finish thread purges before deleting their parent workspaces.
        await emptyTrashAsync();
        for (const project of projects.filter(project => project.deletedAt)) await purgeProject(project.id);
      }
      if (mounted.current) {
        toast.success(entry ? `${entry.kind === 'thread' ? 'Thread' : 'Workspace'} permanently deleted` : 'Trash emptied');
        refocus();
      }
    } catch (reason) {
      if (mounted.current) setError(`Could not ${entry ? 'delete this item' : 'empty trash'}: ${reason instanceof Error ? reason.message : 'Request failed'}`);
      returnFocus = true;
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        if (returnFocus) focusFrame.current = requestAnimationFrame(() => {
          if (mounted.current) (trigger?.isConnected ? trigger : search.current)?.focus({ preventScroll: true });
        });
      }
    }
  };
  const changeQuery = (value: string) => { setQuery(value); setSearchCollapsed(new Set()); setMenu(null); };
  const row = (entry: TrashEntry) => <TrashRow key={entryKey(entry)} entry={entry} nodes={nodes} query={query} ttl={ttl} now={now} busy={busy} menuOpen={menu?.key === entryKey(entry)}
    onPreview={() => showPreview(entry)} onRestore={() => restore(entry)}
    onMenu={anchor => setMenu(current => current?.key === entryKey(entry) ? null : { key: entryKey(entry), anchor })} />;

  return <div className="terminal-trash term-scrollbar" ref={page} style={{ background: pageBackground('trash') }} aria-busy={busy || !hydrated}>
    <div className="trash-content">
      <header className="trash-heading">
        <div><div className="trash-heading-title"><h1>Trash</h1><span aria-label={plural(total, 'item')}>{total}</span></div>
          <p className="trash-retention"><Clock3 size={13} aria-hidden="true" />{ttl > 0 ? `Threads are kept for ${plural(ttl, 'day')}` : 'Automatic deletion is off'}</p>
        </div>
        <Button size="sm" disabled={!hydrated || !total || busy} onClick={() => { void purge(); }}><Trash2 size={14} aria-hidden="true" />{busy ? 'Working...' : 'Empty trash'}</Button>
      </header>
      <div className="trash-toolbar">
        <label className="trash-search"><Search size={14} aria-hidden="true" /><input ref={search} type="search" aria-label="Search trash" placeholder="Search trash..." value={query} onChange={event => changeQuery(event.target.value)} />
          {query && <button type="button" aria-label="Clear search" onClick={() => { changeQuery(''); search.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}
        </label>
        <div className="trash-toolbar-end"><span className="trash-result-count" role="status">{query.trim() ? plural(resultCount, 'result') : ''}</span>
          <label className="trash-sort">{oldestFirst ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />}<select aria-label="Sort deleted items" value={oldestFirst ? 'oldest' : 'newest'} onChange={event => setOldestFirst(event.target.value === 'oldest')} disabled={!total}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
        </div>
      </div>
      {error && <div className="trash-error" role="alert"><span>{error}</span><TrashIconButton icon={X} tooltip="Dismiss error" aria-label="Dismiss error" onClick={() => setError(null)} /></div>}
      {!hydrated ? <div className="trash-loading" role="status" aria-label="Loading trash"><span /><span /><span /></div> : !resultCount ? <div className="trash-empty">
        {total ? <Search size={30} aria-hidden="true" /> : <Trash2 size={30} aria-hidden="true" />}
        <h2>{total ? 'No matching items' : 'Trash is empty'}</h2>
        <p>{total ? `Nothing matches "${query.trim()}".` : 'No deleted threads or workspaces.'}</p>
        {total > 0 && <Button variant="ghost" size="sm" onClick={() => { changeQuery(''); search.current?.focus(); }}>Clear search</Button>}
      </div> : <>
        {liveSections.map(section => {
          const closed = activeCollapsed.has(section.project.id);
          return <section className="trash-group" key={section.project.id}>
            <h2><button type="button" className="trash-group-heading" aria-expanded={!closed} onClick={() => {
              const setter = query.trim() ? setSearchCollapsed : setCollapsed;
              setter(previous => { const next = new Set(previous); if (next.has(section.project.id)) next.delete(section.project.id); else next.add(section.project.id); return next; });
            }}>{closed ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}<Folder size={15} aria-hidden="true" style={{ color: workspaceAccent(section.project.id) }} /><span className="trash-group-name"><TrashHighlight text={section.project.name} query={query} /></span><span className="trash-group-count">{section.groups.length}</span></button></h2>
            {!closed && <div className="trash-group-rows">{section.groups.map(group => row({ kind: 'thread', project: section.project, group }))}</div>}
          </section>;
        })}
        {deletedSections.length > 0 && <section className={`trash-group trash-deleted-workspaces${liveSections.length ? ' has-threads' : ''}`}>
          <h2 className="trash-group-heading">Deleted workspaces <span className="trash-group-count">{deletedSections.length}</span></h2>
          <div className="trash-group-rows">{deletedSections.map(section => row({ kind: 'workspace', ...section }))}</div>
        </section>}
      </>}
    </div>
    {menu && menuEntry && !busy && <TrashMenu anchor={menu.anchor} onClose={() => setMenu(null)} onPreview={() => showPreview(menuEntry)} onRestore={() => restore(menuEntry)} onDelete={() => { void purge(menuEntry); }} />}
    {preview && <TrashPreview entry={preview} nodes={nodes} ttl={ttl} now={now} busy={busy} onClose={closePreview} onRestore={restore} onDelete={entry => { void purge(entry); }} onPreview={showPreview} />}
  </div>;
}

function TrashRow({ entry, nodes, query, ttl, now, busy, menuOpen, onPreview, onRestore, onMenu }: {
  entry: TrashEntry;
  nodes: ReturnType<typeof useChatNodesSnapshot>;
  query: string; ttl: number; now: number; busy: boolean; menuOpen: boolean;
  onPreview: () => void; onRestore: () => void; onMenu: (anchor: HTMLButtonElement) => void;
}) {
  const thread = entry.kind === 'thread';
  const title = entryTitle(entry);
  const timestamp = entryDeletedAt(entry);
  const age = relativeDeletion(timestamp, now);
  const days = thread ? remainingDays(entry.group, ttl, now) : null;
  const expiry = days !== null && days <= 3 ? (days === 0 ? 'Due for deletion' : `${days}d left`) : null;
  const count = thread ? plural(entry.group.members.length, 'node') : plural(entry.project.trees.filter(tree => !nodes[tree.rootNodeId]?.deletedAt).length + entry.groups.length, 'thread');
  const extra = thread ? plural(entry.group.messageCount, 'message') : entry.project.cwd;
  return <article className="trash-row" data-trash-key={entryKey(entry)}>
    <button type="button" className="trash-row-open" data-trash-open={entryKey(entry)} aria-label={`Preview ${title}`} onClick={onPreview}>
      <span className="trash-row-icon">{thread ? <MessageSquare size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}</span>
      <span className="trash-row-content"><span className="trash-row-title"><TrashHighlight text={title} query={query} /></span>
        <span className="trash-row-meta"><span>{count}</span>{extra && <span className="trash-desktop-meta"><span aria-hidden="true"> · </span>{extra}</span>}<span className={`trash-mobile-date${expiry ? ' trash-expiry' : ''}`}><span aria-hidden="true"> · </span>{expiry || age}</span></span>
      </span>
    </button>
    <time className="trash-row-date" dateTime={timestamp ? new Date(timestamp).toISOString() : undefined} title={timestamp ? `Deleted ${new Date(timestamp).toLocaleString()}` : undefined}><span>{age}</span>{expiry && <span className="trash-expiry"><Clock3 size={11} aria-hidden="true" />{expiry}</span>}</time>
    <div className="trash-row-actions">
      <TrashIconButton icon={Undo2} tooltip={`Restore ${entry.kind}`} aria-label={`Restore ${title}`} disabled={busy} onClick={onRestore} />
      <TrashIconButton icon={Ellipsis} tooltip="More actions" aria-label={`More actions for ${title}`} aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy} onClick={event => onMenu(event.currentTarget)} />
    </div>
  </article>;
}
