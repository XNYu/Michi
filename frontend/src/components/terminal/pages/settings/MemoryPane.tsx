import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  MEMORY_BODY_MAX_CHARS,
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryMode,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryScope,
} from 'michi-shared';
import type { PageId } from '../../../../state/commands';
import type { Project } from '../../../../state/chatTypes';
import { useChatActions, useChatProjects } from '../../../../state/chatStore';
import { navigateToNode } from '../../../../state/navigateToNode';
import { isSystemWorkspace } from '../../../../state/assistant/systemWorkspace';
import { notePendingMemories, onMemoryChanged, runSelfCreate, runSelfMutation } from '../../../../state/memory/memoryNotifications';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { relativeTime } from '../../../../lib/relativeTime';
import {
  approveMemory,
  createMemory,
  deleteMemory,
  fetchMemoryExtractionStatus,
  fetchMemorySettings,
  isMemoryNotFound,
  isMemoryUnavailable,
  isMemoryVersionConflict,
  listMemories,
  rejectMemory,
  saveMemorySettings,
  setMemoryExtractionPaused,
  updateMemory,
  type MemoryApiError,
  type MemoryExtractionStatus,
} from '../../../../services/api/memories';
import { Button } from '../../../ui/controls';
import { Radio, type RadioOption } from './controls';
import { SettingsRow, SettingsSection } from './SettingsSection';
import './memory.css';

/**
 * Settings › Memory: the memory mode, what agents remember (searchable, by
 * scope), memories waiting for approval, and automatic memory's status.
 * Everything is on this machine's backend; a workspace on another machine
 * keeps its memories there.
 */

export const MEMORY_MODE_OPTIONS: ReadonlyArray<RadioOption<MemoryMode>> = [
  { value: 'off', label: 'Off', description: 'Agents don’t read or save memories. Saved memories stay here until you delete them.' },
  { value: 'explicit', label: 'Explicit only', description: 'Agents save a memory only when you ask them to remember something.' },
  { value: 'auto', label: 'Automatic', description: 'Michi also suggests memories from your conversations. Suggestions wait for your approval below.' },
];

const KIND_LABEL: Record<MemoryKind, string> = { preference: 'Preference', fact: 'Fact', decision: 'Decision', convention: 'Convention' };
const ORIGIN_LABEL: Record<MemoryOrigin, string> = { explicit: 'Explicit', extracted: 'Automatic' };
const LIST_PAGE = 50;
const LIST_MAX = 200;
const PENDING_LIMIT = 200;
const SEARCH_DEBOUNCE_MS = 250;
const RELOAD_DEBOUNCE_MS = 250;

type Filter = 'all' | 'user' | 'workspace';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function updatedText(updatedAt: number): string {
  const ago = relativeTime(updatedAt);
  return ago === 'now' ? 'Updated just now' : ago === 'yesterday' ? 'Updated yesterday' : `Updated ${ago} ago`;
}

function previewOf(body: string): string {
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

const scopeKey = (scope: MemoryScope) => scope.kind === 'user' ? 'user' : `workspace:${scope.workspaceId}`;
const sameScope = (a: MemoryScope, b: MemoryScope) => scopeKey(a) === scopeKey(b);

/** Workspace names, scopes the user can pick, and opening a memory's source conversation. */
interface MemoryContext {
  /** The open workspace, when it is on this machine (its memories are here). */
  workspace: Project | null;
  scopeLabel: (scope: MemoryScope) => string;
  scopeChoices: (current?: MemoryScope) => MemoryScope[];
  /** The source conversation when this machine has it loaded. */
  sourceNode: (record: MemoryRecord) => string | null;
  openSource: (nodeId: string) => void;
}

function useMemoryContext(onNav?: (page: PageId) => void): MemoryContext {
  const { projects, activeProject, activeProjectId } = useChatProjects();
  const { selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId } = useChatActions();
  const workspace = activeProject && !activeProject.deletedAt && !activeProject.archivedAt && !isSystemWorkspace(activeProject)
    && backendConnectionIdForWorkspace(activeProject.id) === LOCAL_BACKEND_CONNECTION_ID ? activeProject : null;
  return useMemo(() => {
    const workspaceName = (id: string) => projects.find((project) => project.id === id)?.name || 'Another workspace';
    return {
      workspace,
      scopeLabel: (scope) => scope.kind === 'user' ? 'Global' : workspaceName(scope.workspaceId),
      scopeChoices: (current) => {
        const choices: MemoryScope[] = [{ kind: 'user' }];
        if (workspace) choices.push({ kind: 'workspace', workspaceId: workspace.id });
        if (current && !choices.some((choice) => sameScope(choice, current))) choices.push(current);
        return choices;
      },
      sourceNode: (record) => {
        const nodeId = record.source?.nodeId;
        if (!nodeId) return null;
        return projects.some((project) => !project.deletedAt && project.chatIds.includes(nodeId)) ? nodeId : null;
      },
      // An explicit request: opens the conversation wherever it lives, then leaves Settings.
      openSource: (nodeId) => {
        navigateToNode({ projects, activeProjectId, selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId }, nodeId);
        onNav?.('dashboard');
      },
    };
  }, [projects, activeProjectId, workspace, selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId, onNav]);
}

// ── the pane ───────────────────────────────────────────────────────────────

type Load<T> = { status: 'loading' | 'ready' | 'error'; value: T; error: string | null };

export function MemoryPane({ onNav }: { onNav?: (page: PageId) => void }) {
  const context = useMemoryContext(onNav);
  const [settings, setSettings] = useState<{ status: 'loading' | 'ready' | 'unavailable' | 'error'; mode: MemoryMode | null; error: string | null }>(
    { status: 'loading', mode: null, error: null });
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setSettings((current) => ({ ...current, status: current.mode ? current.status : 'loading', error: null }));
    try {
      const value = await fetchMemorySettings();
      setSettings({ status: 'ready', mode: value.mode, error: null });
    } catch (error) {
      if (isMemoryUnavailable(error)) setSettings({ status: 'unavailable', mode: null, error: null });
      else setSettings({ status: 'error', mode: null, error: errorText(error, 'unknown error') });
    }
  }, []);
  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const changeMode = async (mode: MemoryMode) => {
    if (modeSaving || mode === settings.mode) return;
    const previous = settings.mode;
    setModeSaving(true);
    setModeError(null);
    setSettings((current) => ({ ...current, mode }));
    try {
      const saved = await saveMemorySettings(mode);
      setSettings((current) => ({ ...current, mode: saved.mode }));
    } catch (error) {
      setSettings((current) => ({ ...current, mode: previous }));
      setModeError(`Couldn’t change the memory mode: ${errorText(error, 'unknown error')}`);
    } finally {
      setModeSaving(false);
    }
  };

  if (settings.status === 'loading') return <p className="settings-section__status" role="status">Loading memory…</p>;
  if (settings.status === 'unavailable') {
    return <SettingsSection title="Memory" intro="This Michi backend doesn’t support Memory yet. Its settings appear here once it does." />;
  }
  if (settings.status === 'error' || !settings.mode) {
    return (
      <SettingsSection title="Memory">
        <p className="settings-section__error" role="alert">
          Couldn’t load Memory{settings.error ? `: ${settings.error}` : ''}.{' '}
          <button type="button" className="settings-row__link" onClick={() => { void loadSettings(); }}>Try again</button>
        </p>
      </SettingsSection>
    );
  }
  const mode = settings.mode;
  return (
    <>
      <SettingsSection title="Memory"
        intro="Short notes about your preferences and projects that every runtime can read. Correct or delete any of them here.">
        <SettingsRow label="Memory mode">
          <Radio label="Memory mode" opts={MEMORY_MODE_OPTIONS} value={mode} onChange={(value) => { void changeMode(value); }} />
          <p className="settings-row__note">Turning memory off doesn’t delete chat history. Conversations are kept as before.</p>
          {modeSaving && <p className="settings-row__note" role="status">Saving…</p>}
          {modeError && <p className="settings-row__note" role="alert">{modeError}</p>}
        </SettingsRow>
      </SettingsSection>
      {mode === 'auto' && <AutomaticMemorySection />}
      <MemoryLists mode={mode} context={context} />
    </>
  );
}

// ── automatic memory (C5) ──────────────────────────────────────────────────

interface ExtractionView { label: string; description: string; action: 'pause' | 'resume' | null }

/** Label, explanation and the one action that applies; backends without `state` fall back to `paused`. */
function extractionView(status: MemoryExtractionStatus): ExtractionView {
  if (!status.enabled) return { label: 'Off', description: 'Turn on Automatic above to get suggestions.', action: null };
  if (status.supported === false || status.state === 'unsupported') {
    return { label: 'Unsupported', description: 'This backend can’t read conversations in the background.', action: null };
  }
  switch (status.state ?? (status.paused ? 'paused' : 'running')) {
    case 'paused': return { label: 'Paused', description: 'Paused. No conversations are read until you resume.', action: 'resume' };
    case 'maintenance_paused':
      return { label: 'Paused', description: 'Meta agent background work is paused in Settings › Meta agent.', action: null };
    case 'stopped': return { label: 'Stopped', description: 'Stopped after repeated failures. Resume to try again.', action: 'resume' };
    case 'budget_exhausted': return { label: 'Daily limit reached', description: 'Resumes tomorrow, when the daily token limit resets.', action: 'pause' };
    case 'waiting': return { label: 'Waiting', description: 'New conversations are queued and will be read soon.', action: 'pause' };
    case 'idle': return { label: 'Up to date', description: 'Checks new conversations as they finish.', action: 'pause' };
    default: return { label: 'Running', description: 'Checks new conversations as they finish.', action: 'pause' };
  }
}

function AutomaticMemorySection() {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'unavailable' | 'error'; value: MemoryExtractionStatus | null; error: string | null }>(
    { status: 'loading', value: null, error: null });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const value = await fetchMemoryExtractionStatus();
      setState(value ? { status: 'ready', value, error: null } : { status: 'unavailable', value: null, error: null });
    } catch (error) {
      setState((current) => ({ status: current.value ? 'ready' : 'error', value: current.value, error: errorText(error, 'unknown error') }));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const togglePause = async (paused: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      const value = await setMemoryExtractionPaused(paused);
      if (value) setState({ status: 'ready', value, error: null });
      else await load();
    } catch (error) {
      setActionError(`Couldn’t ${paused ? 'pause' : 'resume'} automatic memory: ${errorText(error, 'unknown error')}`);
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'loading') return <SettingsSection title="Automatic memory"><p className="settings-section__status" role="status">Loading…</p></SettingsSection>;
  if (state.status === 'unavailable') {
    return <SettingsSection title="Automatic memory" aside={<span className="settings-row__state">Unavailable</span>}
      intro="This Michi backend can’t suggest memories yet. Agents still save memories when you ask." />;
  }
  if (state.status === 'error' || !state.value) {
    return (
      <SettingsSection title="Automatic memory">
        <p className="settings-section__error" role="alert">
          Couldn’t read automatic memory’s status{state.error ? `: ${state.error}` : ''}.{' '}
          <button type="button" className="settings-row__link" onClick={() => { void load(); }}>Try again</button>
        </p>
      </SettingsSection>
    );
  }
  const status = state.value;
  const view = extractionView(status);
  const tokens = status.todayTokens.toLocaleString();
  return (
    <SettingsSection title="Automatic memory" aside={<span className="settings-row__state">{view.label}</span>}
      intro="Reads finished conversations in the background and suggests memories for you to approve.">
      <SettingsRow label="Background suggestions"
        description={view.description}
        control={status.enabled && view.action ? (
          <Button size="sm" disabled={busy} onClick={() => { void togglePause(view.action === 'pause'); }}>
            {view.action === 'resume' ? 'Resume automatic memory' : 'Pause automatic memory'}
          </Button>
        ) : undefined}>
        {status.stateReason && <p className="settings-row__note">{status.stateReason}</p>}
        {actionError && <p className="settings-row__note" role="alert">{actionError}</p>}
      </SettingsRow>
      <SettingsRow label="Last run" control={<span className="settings-row__state">
        {status.lastRunAt ? <time dateTime={new Date(status.lastRunAt).toISOString()}>{updatedText(status.lastRunAt).replace('Updated ', '')}</time> : 'Not yet'}
      </span>}>
        {status.lastError && <p className="settings-row__note" role="alert">Last error: {status.lastError}</p>}
      </SettingsRow>
      <SettingsRow label="Today"
        control={<span className="settings-row__state">
          {status.dailyTokenLimit ? `${tokens} of ${status.dailyTokenLimit.toLocaleString()} tokens` : `${tokens} tokens`}
        </span>} />
    </SettingsSection>
  );
}

// ── pending and saved lists ────────────────────────────────────────────────

function MemoryLists({ mode, context }: { mode: MemoryMode; context: MemoryContext }) {
  const workspaceId = context.workspace?.id ?? null;
  const [filter, setFilter] = useState<Filter>('all');
  const effectiveFilter: Filter = filter === 'workspace' && !workspaceId ? 'all' : filter;
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const [saved, setSaved] = useState<Load<{ items: MemoryRecord[]; nextCursor: string | null }>>(
    { status: 'loading', value: { items: [], nextCursor: null }, error: null });
  const [pending, setPending] = useState<Load<MemoryRecord[]>>({ status: 'loading', value: [], error: null });
  const savedGeneration = useRef(0);
  const pendingGeneration = useRef(0);
  const loadedCount = useRef(0);
  loadedCount.current = saved.value.items.length;

  const savedQuery = useMemo(() => ({
    status: ['active'] as const,
    ...(effectiveFilter === 'user' ? { scope: 'user' as const } : {}),
    ...(effectiveFilter === 'workspace' && workspaceId ? { scope: 'workspace' as const, workspaceId } : {}),
    ...(q ? { q } : {}),
  }), [effectiveFilter, workspaceId, q]);

  /** Reads the saved list again, as far as it was shown; returns the records. */
  const reloadSaved = useCallback(async (options: { keepLength?: boolean } = {}): Promise<MemoryRecord[] | null> => {
    const mine = ++savedGeneration.current;
    const limit = options.keepLength ? Math.min(LIST_MAX, Math.max(LIST_PAGE, loadedCount.current)) : LIST_PAGE;
    try {
      const page = await listMemories({ ...savedQuery, limit });
      if (mine !== savedGeneration.current) return null;
      setSaved({ status: 'ready', value: page, error: null });
      return page.items;
    } catch (error) {
      if (mine !== savedGeneration.current) return null;
      setSaved((current) => ({ status: 'error', value: current.value, error: errorText(error, 'unknown error') }));
      return null;
    }
  }, [savedQuery]);

  const reloadPending = useCallback(async () => {
    const mine = ++pendingGeneration.current;
    try {
      const page = await listMemories({ status: ['pending'], limit: PENDING_LIMIT });
      if (mine !== pendingGeneration.current) return;
      setPending({ status: 'ready', value: page.items, error: null });
      notePendingMemories(page.items.length, page.nextCursor !== null);
    } catch (error) {
      if (mine !== pendingGeneration.current) return;
      setPending((current) => ({ status: 'error', value: current.value, error: errorText(error, 'unknown error') }));
    }
  }, []);

  // A new filter or search starts the list over.
  useEffect(() => {
    setSaved((current) => ({ ...current, status: 'loading' }));
    void reloadSaved();
  }, [reloadSaved]);
  useEffect(() => { void reloadPending(); }, [reloadPending]);

  // Changes made anywhere (an agent, another window, an Undo) refresh both lists.
  const reloadRef = useRef({ reloadSaved, reloadPending });
  reloadRef.current = { reloadSaved, reloadPending };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onMemoryChanged(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reloadRef.current.reloadSaved({ keepLength: true });
        void reloadRef.current.reloadPending();
      }, RELOAD_DEBOUNCE_MS);
    });
    return () => { stop(); if (timer !== null) clearTimeout(timer); };
  }, []);

  const showMore = async () => {
    const cursor = saved.value.nextCursor;
    if (!cursor) return;
    const mine = ++savedGeneration.current;
    try {
      const page = await listMemories({ ...savedQuery, cursor, limit: LIST_PAGE });
      if (mine !== savedGeneration.current) return;
      setSaved((current) => {
        const seen = new Set(current.value.items.map((item) => item.id));
        return { status: 'ready', value: { items: [...current.value.items, ...page.items.filter((item) => !seen.has(item.id))], nextCursor: page.nextCursor }, error: null };
      });
    } catch (error) {
      if (mine === savedGeneration.current) setSaved((current) => ({ ...current, error: errorText(error, 'unknown error') }));
    }
  };

  const replaceSaved = (record: MemoryRecord) => setSaved((current) => ({
    ...current, value: { ...current.value, items: current.value.items.map((item) => item.id === record.id ? record : item) },
  }));
  const removeSaved = (id: string) => setSaved((current) => ({
    ...current, value: { ...current.value, items: current.value.items.filter((item) => item.id !== id) },
  }));
  /** After a conflict: the record as stored now, or null when it is gone. */
  const currentRecord = async (id: string): Promise<MemoryRecord | null | undefined> => {
    const items = await reloadSaved({ keepLength: true });
    return items ? items.find((item) => item.id === id) ?? null : undefined;
  };

  return <>
    <PendingSection items={pending.value} status={pending.status} error={pending.error} context={context}
      onReload={() => { void reloadPending(); void reloadSaved({ keepLength: true }); }} />
    <SettingsSection title="Saved memories" className="memory-saved">
      <div className="memory-toolbar">
        <select className="ui-select settings-row__select" aria-label="Show memories" value={effectiveFilter}
          onChange={(event) => setFilter(event.target.value as Filter)}>
          <option value="all">All memories</option>
          <option value="user">Global only</option>
          {context.workspace && <option value="workspace">{context.workspace.name || 'This workspace'} only</option>}
        </select>
        <input type="search" className="ui-input memory-toolbar__search" aria-label="Search memories" placeholder="Search memories"
          value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <AddMemory mode={mode} context={context} onAdded={(record) => {
        setSaved((current) => ({ ...current, value: { ...current.value, items: [record, ...current.value.items.filter((item) => item.id !== record.id)] } }));
        void reloadSaved({ keepLength: true });
      }} />
      {saved.status === 'loading' && saved.value.items.length === 0 && <p className="settings-section__status" role="status">Loading memories…</p>}
      {saved.error && <p className="settings-section__error" role="alert">Couldn’t load memories: {saved.error}</p>}
      {saved.status === 'ready' && saved.value.items.length === 0 && (
        <p className="settings-section__status">{q ? `No memories match “${q}”.` : effectiveFilter === 'all' ? 'No memories yet.' : 'No memories here yet.'}</p>
      )}
      {saved.value.items.length > 0 && <ul className="memory-list" aria-label="Saved memories">
        {saved.value.items.map((record) => (
          <SavedMemoryItem key={record.id} record={record} context={context}
            onReplace={(next) => { replaceSaved(next); if (!sameScope(next.scope, record.scope)) void reloadSaved({ keepLength: true }); }}
            onRemoved={() => removeSaved(record.id)}
            onConflict={() => currentRecord(record.id)} />
        ))}
      </ul>}
      {saved.value.nextCursor && <Button size="sm" className="memory-more" onClick={() => { void showMore(); }}>Show more</Button>}
    </SettingsSection>
  </>;
}

function MemoryMeta({ record, context }: { record: MemoryRecord; context: MemoryContext }) {
  const source = context.sourceNode(record);
  return (
    <div className="memory-item__meta">
      <span>{KIND_LABEL[record.kind]}</span>
      <span>{context.scopeLabel(record.scope)}</span>
      <span>{ORIGIN_LABEL[record.origin]}</span>
      <time dateTime={new Date(record.updatedAt).toISOString()} title={new Date(record.updatedAt).toLocaleString()}>{updatedText(record.updatedAt)}</time>
      {source && <button type="button" className="settings-row__link" onClick={() => context.openSource(source)}>Open conversation</button>}
    </div>
  );
}

type Notice = { tone: 'error' | 'info'; text: string } | null;

function SavedMemoryItem({ record, context, onReplace, onRemoved, onConflict }: {
  record: MemoryRecord;
  context: MemoryContext;
  onReplace: (record: MemoryRecord) => void;
  onRemoved: () => void;
  /** Reads the list again: the stored record, null when it is gone, undefined when it couldn't be read. */
  onConflict: () => Promise<MemoryRecord | null | undefined>;
}) {
  const [editing, setEditing] = useState<{ draft: string; version: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const editorId = useId();

  const conflict = async (what: 'edit' | 'scope') => {
    const current = await onConflict();
    if (current === null) { setEditing(null); setNotice({ tone: 'error', text: 'This memory was deleted somewhere else.' }); return; }
    if (current === undefined) { setNotice({ tone: 'error', text: 'This memory changed somewhere else, and its current version couldn’t be loaded.' }); return; }
    if (what === 'edit') {
      setEditing({ draft: current.body, version: current.version });
      setNotice({ tone: 'error', text: 'This memory changed somewhere else, so your edit wasn’t saved. Its current text is shown.' });
    } else {
      setNotice({ tone: 'error', text: 'This memory changed somewhere else, so its scope wasn’t changed. Try again.' });
    }
  };

  const failed = async (error: unknown, what: 'edit' | 'scope' | 'delete') => {
    if (what !== 'delete' && isMemoryVersionConflict(error)) { await conflict(what); return; }
    if (isMemoryNotFound(error)) { onRemoved(); return; }
    const verb = what === 'edit' ? 'save the memory' : what === 'scope' ? 'change the scope' : 'delete the memory';
    setNotice({ tone: 'error', text: `Couldn’t ${verb}: ${errorText(error, 'unknown error')}` });
  };

  const save = async () => {
    if (!editing || busy) return;
    const body = editing.draft.trim();
    if (!body) { setNotice({ tone: 'error', text: 'A memory can’t be empty. Delete it instead.' }); return; }
    setBusy(true);
    setNotice(null);
    try {
      const updated = await runSelfMutation(record.id, () => updateMemory(record.id, { body, expectedVersion: editing.version }));
      setEditing(null);
      onReplace(updated);
    } catch (error) {
      await failed(error, 'edit');
    } finally {
      setBusy(false);
    }
  };

  const changeScope = async (key: string) => {
    const scope = context.scopeChoices(record.scope).find((choice) => scopeKey(choice) === key);
    if (!scope || sameScope(scope, record.scope) || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      onReplace(await runSelfMutation(record.id, () => updateMemory(record.id, { scope, expectedVersion: record.version })));
    } catch (error) {
      await failed(error, 'scope');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await runSelfMutation(record.id, () => deleteMemory(record.id));
      onRemoved();
    } catch (error) {
      setBusy(false);
      await failed(error, 'delete');
    }
  };

  const label = previewOf(record.body);
  return (
    <li className="memory-item" aria-label={label} aria-busy={busy || undefined}>
      {editing ? (
        <div className="memory-item__editor">
          <label className="sr-only" htmlFor={editorId}>Edit memory</label>
          <textarea id={editorId} className="ui-input memory-item__textarea" value={editing.draft} maxLength={MEMORY_BODY_MAX_CHARS} rows={3}
            autoFocus onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); setNotice(null); }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
            }} />
          <div className="memory-item__actions">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => { void save(); }}>Save</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(null); setNotice(null); }}>Cancel</Button>
          </div>
        </div>
      ) : <p className="memory-item__body">{record.body}</p>}
      <MemoryMeta record={record} context={context} />
      {!editing && <div className="memory-item__actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing({ draft: record.body, version: record.version }); setNotice(null); setConfirmDelete(false); }}>Edit</Button>
        <select className="ui-select memory-item__scope" aria-label="Scope" value={scopeKey(record.scope)} disabled={busy}
          onChange={(event) => { void changeScope(event.target.value); }}>
          {context.scopeChoices(record.scope).map((scope) => <option key={scopeKey(scope)} value={scopeKey(scope)}>{context.scopeLabel(scope)}</option>)}
        </select>
        {confirmDelete ? <>
          <Button size="sm" danger disabled={busy} onClick={() => { void remove(); }}>Confirm delete</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Keep</Button>
        </> : <Button size="sm" variant="ghost" danger disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</Button>}
      </div>}
      {notice && <p className={notice.tone === 'error' ? 'memory-item__notice is-error' : 'memory-item__notice'} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    </li>
  );
}

function PendingSection({ items, status, error, context, onReload }: {
  items: MemoryRecord[];
  status: Load<unknown>['status'];
  error: string | null;
  context: MemoryContext;
  onReload: () => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  // Selection follows the list: a memory handled elsewhere drops out of it.
  useEffect(() => {
    setSelected((current) => {
      const ids = new Set(items.map((item) => item.id));
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const decide = async (ids: readonly string[], decision: 'approve' | 'reject') => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    setNotice(null);
    const failures: string[] = [];
    for (const id of ids) {
      try {
        await runSelfMutation<unknown>(id, () => decision === 'approve' ? approveMemory(id) : rejectMemory(id));
      } catch (failure) {
        // Already handled elsewhere: the reload shows where it went.
        if (isMemoryNotFound(failure) || (failure as MemoryApiError)?.code === 'invalid_state') continue;
        failures.push(errorText(failure, 'unknown error'));
      }
    }
    setSelected(new Set());
    setBusy(false);
    onReload();
    if (failures.length > 0) {
      const verb = decision === 'approve' ? 'approve' : 'reject';
      setNotice({ tone: 'error', text: ids.length === 1 ? `Couldn’t ${verb} the memory: ${failures[0]}` : `Couldn’t ${verb} ${failures.length} of ${ids.length} memories: ${failures[0]}` });
    }
  };

  if (status === 'error' && items.length === 0) {
    return <SettingsSection title="Waiting for confirmation"><p className="settings-section__error" role="alert">Couldn’t load memories waiting for confirmation: {error}</p></SettingsSection>;
  }
  if (items.length === 0) return null;
  const allSelected = selected.size === items.length;
  const selectedIds = items.filter((item) => selected.has(item.id)).map((item) => item.id);
  return (
    <SettingsSection title="Waiting for confirmation" className="memory-pending"
      aside={<span className="settings-row__state">{items.length}</span>}
      intro="Agents suggested these, or saved them while reading web pages or tool output. They aren’t used until you approve them.">
      <div className="memory-bulk">
        <label className="memory-bulk__all">
          <input type="checkbox" checked={allSelected} disabled={busy}
            ref={(input) => { if (input) input.indeterminate = selected.size > 0 && !allSelected; }}
            onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))} />
          Select all
        </label>
        <Button size="sm" disabled={busy || selectedIds.length === 0} onClick={() => { void decide(selectedIds, 'approve'); }}>
          Approve selected{selectedIds.length ? ` (${selectedIds.length})` : ''}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || selectedIds.length === 0} onClick={() => { void decide(selectedIds, 'reject'); }}>
          Reject selected{selectedIds.length ? ` (${selectedIds.length})` : ''}
        </Button>
      </div>
      <ul className="memory-list" aria-label="Waiting for confirmation">
        {items.map((record) => {
          const label = previewOf(record.body);
          return (
            <li key={record.id} className="memory-item memory-item--pending" aria-label={label}>
              <div className="memory-item__row">
                <input type="checkbox" className="memory-item__check" aria-label={`Select “${label}”`} disabled={busy}
                  checked={selected.has(record.id)}
                  onChange={() => setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(record.id)) next.delete(record.id); else next.add(record.id);
                    return next;
                  })} />
                <p className="memory-item__body">{record.body}</p>
              </div>
              {record.sourceRisk === 'untrusted' && (
                <p className="memory-item__warning">
                  <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>Saved while an agent was reading web pages or tool output. Check that it says what you want before approving it.</span>
                </p>
              )}
              <MemoryMeta record={record} context={context} />
              <div className="memory-item__actions">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => { void decide([record.id], 'approve'); }}>Approve</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void decide([record.id], 'reject'); }}>Reject</Button>
              </div>
            </li>
          );
        })}
      </ul>
      {notice && <p className="settings-section__error" role="alert">{notice.text}</p>}
    </SettingsSection>
  );
}

function AddMemory({ mode, context, onAdded }: { mode: MemoryMode; context: MemoryContext; onAdded: (record: MemoryRecord) => void }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [scopeChoice, setScopeChoice] = useState('user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyId = useId();
  const choices = context.scopeChoices();
  const scope = choices.find((choice) => scopeKey(choice) === scopeChoice) ?? choices[0];

  if (!open) {
    return <div className="memory-add">
      <Button size="sm" disabled={mode === 'off'} onClick={() => { setOpen(true); setError(null); }}>Add memory</Button>
      {mode === 'off' && <span className="settings-row__state">Turn memory on to add memories.</span>}
    </div>;
  }
  const save = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const record = await runSelfCreate(() => createMemory({ scope, kind, body: text }));
      setBody('');
      setOpen(false);
      onAdded(record);
    } catch (failure) {
      setError((failure as MemoryApiError)?.code === 'memory_disabled' ? 'Memory is off. Turn it on to add memories.' : `Couldn’t add the memory: ${errorText(failure, 'unknown error')}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="memory-add memory-add--open" role="group" aria-label="Add memory">
      <label className="sr-only" htmlFor={bodyId}>New memory</label>
      <textarea id={bodyId} className="ui-input memory-item__textarea" value={body} rows={2} maxLength={MEMORY_BODY_MAX_CHARS} autoFocus
        placeholder="For example: Answer in Chinese unless I write in English."
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
        }} />
      <div className="memory-item__actions">
        <select className="ui-select memory-item__scope" aria-label="Kind" value={kind} onChange={(event) => setKind(event.target.value as MemoryKind)}>
          {MEMORY_KINDS.map((value) => <option key={value} value={value}>{KIND_LABEL[value]}</option>)}
        </select>
        <select className="ui-select memory-item__scope" aria-label="New memory scope" value={scopeKey(scope)} onChange={(event) => setScopeChoice(event.target.value)}>
          {choices.map((choice) => <option key={scopeKey(choice)} value={scopeKey(choice)}>{context.scopeLabel(choice)}</option>)}
        </select>
        <Button size="sm" variant="primary" disabled={busy || !body.trim()} onClick={() => { void save(); }}>Save memory</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {error && <p className="memory-item__notice is-error" role="alert">{error}</p>}
    </div>
  );
}
