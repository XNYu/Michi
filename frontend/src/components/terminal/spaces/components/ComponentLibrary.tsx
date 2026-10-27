import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { PageComponent, PageComponentInput, PageComponentSource, PageComponentVersionSource, PageBlockInput } from 'michi-shared';
import { deletePageComponent, listPageComponentReferences, listPageComponents, readPageComponent, savePageComponent, updatePageComponent } from '../../../../services/api/pageComponents';
import { BuiltinComponents } from './BuiltinComponents';
import { ComponentPreview } from './ComponentPreview';
import { ComponentSourceAttribution } from './ComponentSourceAttribution';
import './components.css';

export interface ComponentLibraryProps { workspaceId: string; connectionId: string; onClose?: () => void; onSaved?: (component: PageComponent) => void; onInsert?: (component: PageComponent, version: number) => void | Promise<void>; onInsertBlock?: (block: PageBlockInput) => Promise<void>; onOpenSource?: (source: PageComponentSource) => void | boolean | Promise<void | boolean> }
const blank: PageComponentInput = { name: 'new-widget', description: 'A short description of this component.', code: 'const main = document.createElement("main");\nconst heading = document.createElement("h2");\nconst label = document.createElement("p");\nconst button = document.createElement("button");\nbutton.textContent = "Ask about this";\nbutton.addEventListener("click", () => call("ask.draft", `Tell me about ${label.textContent}`));\nmain.append(heading, label, button);\nroot.appendChild(main);\nconst render = (nextProps, nextData) => { heading.textContent = nextProps.title ?? "Hello"; label.textContent = nextData.label ?? "Sample"; };\nrender(props, data);\nglobalThis.onMichiComponentUpdate = render;' };

function isLibraryRevisionConflict(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && (cause as { status?: unknown }).status === 409;
}

/** Native, workspace-scoped component management. Each save is a new immutable version. */
export function ComponentLibrary(props: ComponentLibraryProps) {
  const identity = JSON.stringify([props.connectionId, props.workspaceId]);
  return <ComponentLibrarySession key={identity} {...props} />;
}

function ComponentLibrarySession({ workspaceId, connectionId, onClose, onSaved, onInsert, onInsertBlock, onOpenSource }: ComponentLibraryProps) {
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<PageComponent[]>([]);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<PageComponent | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [versionSource, setVersionSource] = useState<PageComponentVersionSource | null>(null);
  const [references, setReferences] = useState<import('michi-shared').PageComponentReference[]>([]);
  const [draft, setDraft] = useState<PageComponentInput>(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [requiresVersionReview, setRequiresVersionReview] = useState(false);
  const draftDirty = useRef(false);
  const versionChosen = useRef(false);
  const mounted = useRef(false);
  const refreshingRef = useRef(false);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = useCallback(async (force = false) => {
    if (refreshPromise.current) {
      if (!force) return;
      await refreshPromise.current;
      if (!mounted.current) return;
    }
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const request = (async () => {
      try {
        const result = await listPageComponents(workspaceId, connectionId);
        if (!mounted.current) return;
        setItems(result.items);
        setRevision(result.revision);
        const currentSelection = selectedRef.current;
        if (currentSelection) {
          const current = result.items.find(item => item.id === currentSelection.id);
          if (current) {
            if (current.activeVersion !== currentSelection.activeVersion && !versionChosen.current) {
              setRequiresVersionReview(true);
            }
            if (current.libraryRevision !== currentSelection.libraryRevision || current.activeVersion !== currentSelection.activeVersion || current.enabled !== currentSelection.enabled || current.versions !== currentSelection.versions || current.name !== currentSelection.name || current.description !== currentSelection.description || current.updatedAt !== currentSelection.updatedAt) setSelected(current);
          } else {
            setError(`“${currentSelection.name}” is no longer in this workspace library. Refresh the page or select another component.`);
          }
        }
      } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not load components'); }
      finally { refreshingRef.current = false; if (mounted.current) setRefreshing(false); }
    })();
    refreshPromise.current = request;
    try { await request; }
    finally { if (refreshPromise.current === request) refreshPromise.current = null; }
  }, [connectionId, workspaceId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 10_000);
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);
  useEffect(() => {
    let live = true;
    if (!selected) return;
    const targetVersion = selectedVersion ?? selected.activeVersion;
    setVersionSource(null);
    void Promise.all([readPageComponent(selected.id, workspaceId, connectionId, targetVersion), listPageComponentReferences(selected.id, workspaceId, connectionId)]).then(([result, refs]) => { if (live) { if (!draftDirty.current) setDraft({ name: selected.name, description: selected.description, code: result.version.code, propsSchema: result.version.propsSchema ?? undefined }); setReferences(refs); setVersionSource(result.version.source); } }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : 'Could not read component details'); });
    return () => { live = false; };
  }, [connectionId, selected, selectedVersion, workspaceId]);
  const save = async () => {
    if (!mounted.current) return;
    setError(null); setBusy(true);
    try { const result = await savePageComponent(workspaceId, draft, revision, connectionId); if (!mounted.current) return; if (!result.component) throw new Error('Component was saved without a library record'); draftDirty.current = false; versionChosen.current = false; setRequiresVersionReview(false); onSaved?.(result.component); setSelected(result.component); setSelectedVersion(result.component.activeVersion); await refresh(true); if (mounted.current) setRequiresVersionReview(false); }
    catch (cause) {
      if (!mounted.current) return;
      if (isLibraryRevisionConflict(cause)) {
        await refresh(true);
        if (mounted.current) setError('The component library changed in another window. Your code is preserved; review the latest version list and save again.');
      } else setError(cause instanceof Error ? cause.message : 'Could not save component version');
    }
    finally { if (mounted.current) setBusy(false); }
  };
  const action = async (component: PageComponent, kind: 'enable' | 'disable' | 'activate' | 'rollback' | 'delete', targetVersion?: number) => {
    if (!mounted.current) return;
    setError(null); setBusy(true);
    try {
      if (kind === 'delete') await deletePageComponent(component.id, workspaceId, connectionId, revision);
      else { const updated = await updatePageComponent(component.id, kind, workspaceId, connectionId, revision, targetVersion); if (!mounted.current) return; setSelected(updated); setSelectedVersion(updated.activeVersion); }
      if (!mounted.current) return;
      if (kind === 'delete') { setSelected(null); setSelectedVersion(null); }
      await refresh(true);
    } catch (cause) {
      if (!mounted.current) return;
      if (isLibraryRevisionConflict(cause)) {
        await refresh(true);
        if (mounted.current) setError('The component library changed in another window. Your draft is preserved; review the latest versions and retry.');
      } else setError(cause instanceof Error ? cause.message : 'Component action failed');
    }
    finally { if (mounted.current) setBusy(false); }
  };
  const choose = async (item: PageComponent) => { setEditing(true); draftDirty.current = false; versionChosen.current = false; setRequiresVersionReview(false); setSelected(item); setSelectedVersion(item.activeVersion); setError(null); };
  return <section className="page-component-library" aria-label="Native components">
    <header><div><h2>Components</h2><p>Browse building blocks and manage components made for this workspace.</p></div><div><button type="button" disabled={refreshing || busy} onClick={() => void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>{onClose && <button type="button" onClick={onClose}>Close</button>}</div></header>
    {error && <p role="alert" className="page-component-notice">{error}</p>}
    {!editing && <BuiltinComponents onInsert={onInsertBlock} />}
    <div className="component-catalog__heading"><h2>Workspace components</h2><span>{items.length}</span></div>
    <p className="component-catalog__description">Components you or the assistant saved here. Select one to preview it, choose a version or edit its code.</p>
    <div className="page-component-library-grid" data-editing={editing}>
      <nav aria-label="Component library" className="page-component-list">
        {items.map(item => <button type="button" key={item.id} aria-current={selected?.id === item.id ? 'true' : undefined} onClick={() => void choose(item)}>
          <strong>{item.name}</strong><span>{item.description}</span><small>{item.enabled ? `v${item.activeVersion} · enabled` : 'Disabled'} · {item.versions} versions</small>
        </button>)}
        {!items.length && <p className="page-component-empty">No components saved yet.</p>}
        <button type="button" className="page-component-new" onClick={() => { setEditing(true); draftDirty.current = false; versionChosen.current = false; setRequiresVersionReview(false); setSelected(null); setSelectedVersion(null); setDraft(blank); setReferences([]); }}>＋ New component</button>
      </nav>
      {editing && <div className="page-component-editor">
        <button type="button" className="page-component-back" onClick={() => setEditing(false)}>Back to components</button>
        <label>Name<input value={draft.name} onChange={event => { draftDirty.current = true; setDraft({ ...draft, name: event.target.value }); }} maxLength={40} /></label>
        <label>Description<input value={draft.description} onChange={event => { draftDirty.current = true; setDraft({ ...draft, description: event.target.value }); }} maxLength={500} /></label>
        {selected && <label>Version<select value={selectedVersion ?? selected.activeVersion} onChange={event => { draftDirty.current = false; versionChosen.current = true; setRequiresVersionReview(false); setSelectedVersion(Number(event.target.value)); }}>{Array.from({ length: selected.versions }, (_, index) => selected.versions - index).map(itemVersion => <option key={itemVersion} value={itemVersion}>v{itemVersion}{itemVersion === selected.activeVersion ? ' · active' : ''}</option>)}</select></label>}
        {requiresVersionReview && <p role="alert" className="page-component-notice">The active version changed in another window. Review the version list before inserting.</p>}
        {selected && <ComponentSourceAttribution source={versionSource} onOpenSource={onOpenSource} />}
        <label>Component code<textarea spellCheck={false} value={draft.code} onChange={event => { draftDirty.current = true; setDraft({ ...draft, code: event.target.value }); }} rows={12} /></label>
        <div className="page-component-actions"><button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : selected ? 'Save new version' : 'Save component'}</button>
          {selected && <button type="button" disabled={busy || !selected.enabled || !onInsert || requiresVersionReview} onClick={() => {
            if (!onInsert || !mounted.current) return;
            const version = selectedVersion ?? selected.activeVersion;
            if (!Number.isSafeInteger(version) || version < 1 || version > selected.versions) {
              setError('Select a valid component version before inserting it.');
              return;
            }
            setError(null); setBusy(true);
            void (async () => {
              try {
                const latest = await listPageComponents(workspaceId, connectionId);
                if (!mounted.current) return;
                setItems(latest.items);
                setRevision(latest.revision);
                const current = latest.items.find(item => item.id === selected.id);
                if (!current || !current.enabled || version > current.versions) throw new Error('This component is no longer available. Refresh the library and choose another version.');
                if (current.libraryRevision !== selected.libraryRevision || current.activeVersion !== selected.activeVersion || current.enabled !== selected.enabled || current.versions !== selected.versions || current.updatedAt !== selected.updatedAt) setSelected(current);
                if (!versionChosen.current && version === selected.activeVersion && current.activeVersion !== version) {
                  setSelected(current);
                  setRequiresVersionReview(true);
                  throw new Error('The active version changed in another window. Review the version list before inserting.');
                }
                await onInsert(current, version);
              } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not insert component'); }
              finally { if (mounted.current) setBusy(false); }
            })();
          }}>Insert selected component</button>}
          {selected && <><button type="button" disabled={busy} onClick={() => void action(selected, selected.enabled ? 'disable' : 'enable')}>{selected.enabled ? 'Disable' : 'Enable'}</button>
            {selectedVersion !== selected.activeVersion && <><button type="button" disabled={busy} onClick={() => void action(selected, 'activate', selectedVersion ?? undefined)}>Activate v{selectedVersion}</button><button type="button" disabled={busy} onClick={() => void action(selected, 'rollback', selectedVersion ?? undefined)}>Rollback to v{selectedVersion}</button></>}
            <button type="button" disabled={busy} onClick={() => window.confirm(`Delete ${selected.name}? Existing references will show a fallback.`) && void action(selected, 'delete')}>Delete</button></>}
        </div>
        {selected && <div className="page-component-usage"><strong>Usage locations</strong>{references.length ? <ul>{references.map(ref => <li key={`${ref.kind}:${ref.pageId ?? ref.databaseId}:${ref.blockId ?? ref.viewId}`}>{ref.kind === 'page_block' ? `Page ${ref.pageId} · block ${ref.blockId}` : `Database ${ref.databaseId} · view ${ref.viewId}`}{ref.pinnedVersion ? ` · pinned v${ref.pinnedVersion}` : ' · follows active version'}{ref.protected ? ' · protected' : ''}</li>)}</ul> : <p>No active references found. Disable immediately stops every mounted version.</p>}</div>}
        <ComponentPreview connectionId={connectionId} name={draft.name || 'Component'} code={draft.code} />
      </div>}
    </div>
  </section>;
}
