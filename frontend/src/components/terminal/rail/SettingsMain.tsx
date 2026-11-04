import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import type { PageId } from '../../../state/commands';
import type { ChatNodeState } from '../../../state/chatTypes';
import { useChatProjects, useStructuralSelector } from '../../../state/chatStore';
import { isArchiveGroupId } from '../../../state/trashActions';
import { isVisibleConversationNode } from '../../../state/conversationVisibility';
import { useMetaAgentSettingsAlert } from '../../../state/metaAgent/useMetaAgentOverview';
import { useMemoryBadge } from '../../../state/memory/memoryNotifications';
import { useBackendConnections } from '../../../state/useBackendConnections';
import { useAuthSession } from '../../../services/auth';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendConnections';
import { AppearancePane } from '../pages/settings/AppearancePane';
import { SettingsLayoutContext, SettingsTargetContext } from '../pages/settings/settingsPhone';
import { PhoneSettingsMenu } from './PhoneSettingsMenu';
import { SETTINGS_GROUPS, SETTINGS_PAGES, type SettingsPage } from './settingsPages';
import { searchSettings, type SettingsSearchResult } from './settingsSearch';
import '../pages/Settings.css';

// Keep the Settings shell and local appearance controls ready. Other pages
// load only when opened, without suspending the navigation.
const GeneralTopicPage = React.lazy(() => import('./GeneralTopicPage'));
const ModelPane = React.lazy(() => import('../pages/settings/ModelPane').then(module => ({ default: module.ModelPane })));
const MetaAgentSettings = React.lazy(() => import('../settings/metaAgent/MetaAgentSettings').then(module => ({ default: module.MetaAgentSettings })));
const BackupPane = React.lazy(() => import('../pages/settings/BackupPane').then(module => ({ default: module.BackupPane })));
const MemoryPane = React.lazy(() => import('../pages/settings/MemoryPane').then(module => ({ default: module.MemoryPane })));

function SectionContent({ children }: { children: React.ReactNode }) {
  return <React.Suspense fallback={<div role="status">Loading settings…</div>}>{children}</React.Suspense>;
}

function countGroups(nodes: Record<string, ChatNodeState>, belongs: (node: ChatNodeState) => boolean): number {
  const groups = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.deletionGroupId && belongs(node)) groups.add(`${node.projectId}:${node.deletionGroupId}`);
  }
  return groups.size;
}

/** What Trash and Archived hold: deleted thread groups plus deleted workspaces, and archived groups. */
function useHistoryCounts(): { trash: number; archived: number } {
  const { projects } = useChatProjects();
  const liveProjectIds = useMemo(() => new Set(projects.filter((project) => !project.deletedAt).map((project) => project.id)), [projects]);
  const deletedProjects = useMemo(() => projects.filter((project) => project.deletedAt).length, [projects]);
  const trashGroups = useStructuralSelector(useCallback((nodes: Record<string, ChatNodeState>) => countGroups(nodes, (node) =>
    liveProjectIds.has(node.projectId) && !isArchiveGroupId(node.deletionGroupId) && isVisibleConversationNode(node)), [liveProjectIds]));
  const archived = useStructuralSelector(useCallback((nodes: Record<string, ChatNodeState>) => countGroups(nodes, (node) =>
    isArchiveGroupId(node.deletionGroupId)), []));
  return { trash: trashGroups + deletedProjects, archived };
}

/** The element of a page that shows a setting, found by the name a search result carries. */
const SETTING_NAMES = '.settings-row__label, .settings-field__label, .settings-section__title, .settings-backup__title, .meta-set__row-k, .meta-set__radio-t, .settings-shortcut-row__label';
const SETTING_BLOCKS = '.settings-row, .settings-field, .meta-set__row, .meta-set__radio, .settings-shortcut-row, .settings-section, .settings-backup';
function findSetting(root: HTMLElement, label: string): HTMLElement | null {
  const name = Array.from(root.querySelectorAll<HTMLElement>(SETTING_NAMES)).find((element) => element.textContent?.trim() === label);
  return name ? name.closest<HTMLElement>(SETTING_BLOCKS) ?? name : null;
}

export type SettingsLevel = 'menu' | 'section';

/** "3", or "200+" past the pending list's limit; "" for none. */
function memoryPendingLabel(count: number, more: boolean): string {
  if (count <= 0) return '';
  return more ? `${count}+` : String(count);
}

/** The desktop window's navigation: search, then every page in its group. */
function WindowNav({ page, query, onQuery, onOpen, onNav, onSubmit, history, metaAgentAlert, memoryPending, searchRef }: {
  page: SettingsPage;
  query: string;
  onQuery: (query: string) => void;
  onOpen: (page: SettingsPage) => void;
  onNav: (page: PageId) => void;
  onSubmit: () => void;
  history: { trash: number; archived: number };
  metaAgentAlert: boolean;
  /** Memories waiting for approval, shown as Memory's count ("" for none). */
  memoryPending: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
}) {
  const signedIn = !!useAuthSession()?.user;
  const machineIssue = useBackendConnections().some((connection) => connection.id !== LOCAL_BACKEND_CONNECTION_ID && connection.tunnelStatus === 'error');
  const baseId = useId();
  const alert: Partial<Record<SettingsPage, string>> = {
    ...(metaAgentAlert ? { 'meta-agent': 'needs attention' } : {}),
    ...(machineIssue ? { machines: 'connection issue' } : {}),
  };
  return (
    <nav className="settings-window__nav term-scrollbar" aria-label="Settings sections">
      <div className="settings-window__search">
        <Search size={14} strokeWidth={1.75} aria-hidden="true" />
        <input ref={searchRef} type="search" aria-label="Search settings" placeholder="Search settings" autoFocus
          value={query} onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape clears a query first; with none, it reaches the window and closes it.
            if (event.key === 'Escape' && query) { event.preventDefault(); event.stopPropagation(); onQuery(''); }
            if (event.key === 'Enter' && query) { event.preventDefault(); onSubmit(); }
          }} />
        {query && <button type="button" className="settings-window__clear" aria-label="Clear search" onClick={() => { onQuery(''); searchRef.current?.focus(); }}>
          <X size={13} strokeWidth={1.75} aria-hidden="true" />
        </button>}
      </div>
      {SETTINGS_GROUPS.map((group, index) => {
        const headingId = `${baseId}-${index}`;
        return <div key={group.title} className="settings-window__group" role="group" aria-labelledby={headingId}>
          <h2 id={headingId} className="settings-window__heading">{group.title}</h2>
          {group.items.map((item) => {
            if (item.kind === 'place') {
              const count = history[item.place.id];
              const countId = `${headingId}-${item.place.id}`;
              const Icon = item.place.icon;
              return <button key={item.place.id} type="button" className="settings-window__item" onClick={() => onNav(item.place.page)}
                aria-describedby={count > 0 ? countId : undefined}>
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" /><span>{item.place.label}</span>
                {count > 0 && <em id={countId} aria-hidden="true">{count}</em>}
              </button>;
            }
            const info = SETTINGS_PAGES[item.page];
            if ((item.page === 'account' && !signedIn) || info.only === 'phone') return null;
            const Icon = info.icon;
            const status = alert[item.page];
            const count = item.page === 'memory' ? memoryPending : '';
            const countId = `${headingId}-${item.page}`;
            return <button key={item.page} type="button" className="settings-window__item"
              aria-current={item.page === page && !query ? 'page' : undefined}
              aria-label={status ? `${info.label}, ${status}` : undefined}
              aria-describedby={count ? countId : undefined}
              onClick={() => onOpen(item.page)}>
              <Icon size={14} strokeWidth={1.75} aria-hidden="true" /><span>{info.label}</span>
              {count && <em id={countId} aria-hidden="true">{count}</em>}
              {status && <i className="settings-window__alert" aria-hidden="true" />}
            </button>;
          })}
        </div>;
      })}
    </nav>
  );
}

/** Matching settings, each with where it is; picking one opens its page there. */
function SearchResults({ query, results, onPick }: { query: string; results: SettingsSearchResult[]; onPick: (result: SettingsSearchResult) => void }) {
  return (
    <section className="terminal-settings-content settings-window__results term-scrollbar" aria-label="Search results">
      <p className="settings-window__count" role="status">
        {results.length === 0 ? <>No settings match “{query.trim()}”.</> : <>{results.length} {results.length === 1 ? 'setting matches' : 'settings match'} “{query.trim()}”</>}
      </p>
      {results.length > 0 && <ul className="settings-window__hits">
        {results.map((result) => <li key={`${result.page}:${result.group ?? ''}:${result.label}`}>
          <button type="button" className="settings-window__hit" onClick={() => onPick(result)}>
            <span className="settings-window__path">{result.path}</span>
            <span className="settings-window__name">{result.label}</span>
            {result.description && <span className="settings-window__desc">{result.description}</span>}
            <ChevronRight className="settings-window__chevron" size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </li>)}
      </ul>}
      {results.length === 0 && <p className="settings-window__tip">Try a setting’s name, like Reduce motion, or a word such as theme or permissions.</p>}
    </section>
  );
}

/**
 * Settings pages, one topic each (settingsPages.ts), in two layouts.
 *
 * On a phone (`stacked`, a drawer that fills the screen) Settings shows one
 * level at a time, like a phone's own settings: a grouped list
 * (PhoneSettingsMenu), then the chosen page alone. The host owns the level
 * (`view`) so its header Back can return from a page to the list.
 *
 * On a desktop the host shows Settings as a window: search and the grouped
 * pages on the left, the page on the right. A search replaces the page with
 * matching settings; picking one opens its page and points at the setting.
 *
 * The host owns the page, so Settings reopens where it was left and a request
 * (the Meta agent's alert) can open a page directly.
 */
export default function SettingsMain({ page, onPageChange, workspaceReady = true, onNav, view: hostView, onViewChange, stacked = false }: {
  page: SettingsPage;
  onPageChange: (page: SettingsPage) => void;
  workspaceReady?: boolean;
  onNav: (page: PageId) => void;
  view?: SettingsLevel;
  onViewChange?: (view: SettingsLevel) => void;
  stacked?: boolean;
}) {
  const { activeProject } = useChatProjects();
  const history = useHistoryCounts();
  const metaAgentAlert = useMetaAgentSettingsAlert();
  const memoryBadge = useMemoryBadge();
  const memoryPending = workspaceReady ? memoryPendingLabel(memoryBadge.pendingCount, memoryBadge.pendingMore) : '';
  const label = SETTINGS_PAGES[page].label;
  const contentId = useId();
  const [ownView, setOwnView] = useState<SettingsLevel>('menu');
  const view = hostView ?? ownView;
  const [query, setQuery] = useState('');
  // The setting a search result points at; a new pick remounts its page.
  const [target, setTarget] = useState<{ label: string; seq: number } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  // Switching level in a stacked drawer hides what has focus (the picked row,
  // or the page the header Back left), so focus follows: to the page's
  // heading, or back to the row of the page just left.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const setRowRef = useCallback((id: string, button: HTMLButtonElement | null) => {
    if (button) rowRefs.current.set(id, button); else rowRefs.current.delete(id);
  }, []);
  const previousView = useRef(view);
  useEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (!stacked || previous === view) return;
    if (view === 'section') headingRef.current?.focus({ preventScroll: true });
    else rowRefs.current.get(page)?.focus({ preventScroll: true });
  }, [view, stacked, page]);

  const openPage = (next: SettingsPage, reveal?: string) => {
    setOwnView('section');
    onViewChange?.('section');
    onPageChange(next);
    setQuery('');
    setTarget(reveal ? (current) => ({ label: reveal, seq: (current?.seq ?? 0) + 1 }) : null);
  };

  const results = useMemo(() => stacked ? [] : searchSettings(query,
    (Object.keys(SETTINGS_PAGES) as SettingsPage[]).filter((id) => SETTINGS_PAGES[id].only !== 'phone'),
    (id) => SETTINGS_GROUPS.find((group) => group.items.some((item) => item.kind === 'page' && item.page === id))?.title ?? ''),
  [query, stacked]);
  const pick = (result: SettingsSearchResult) => {
    openPage(result.page, result.label);
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  };

  // A picked search result scrolls its setting into view and marks it briefly.
  useEffect(() => {
    if (!target) return;
    let frames = 0;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reveal = () => {
      const root = contentRef.current;
      const setting = root && findSetting(root, target.label);
      if (setting) {
        setting.scrollIntoView?.({ block: 'center' });
        setting.setAttribute('data-search-hit', '');
        timer = setTimeout(() => setting.removeAttribute('data-search-hit'), 2400);
        return;
      }
      // Pages load lazily; stop looking after about a second and a half.
      if (++frames < 90) frame = requestAnimationFrame(reveal);
    };
    frame = requestAnimationFrame(reveal);
    return () => { cancelAnimationFrame(frame); if (timer) clearTimeout(timer); };
  }, [target]);

  // ⌘F / Ctrl+F searches Settings while the window is open, not the page behind it.
  useEffect(() => {
    if (stacked) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      event.stopPropagation();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [stacked]);

  const waiting = <div role="status">Loading workspaces…</div>;
  let body: React.ReactNode;
  switch (page) {
    case 'runtime':
      body = workspaceReady ? <ModelPane activeProjectId={activeProject?.id ?? null} /> : waiting;
      break;
    case 'meta-agent':
      body = <MetaAgentSettings />;
      break;
    case 'appearance':
      body = <AppearancePane />;
      break;
    case 'backup':
      body = workspaceReady ? <BackupPane /> : waiting;
      break;
    case 'memory':
      body = workspaceReady ? <MemoryPane onNav={onNav} /> : waiting;
      break;
    default:
      body = <GeneralTopicPage page={page} workspaceReady={workspaceReady} onNav={onNav} />;
  }
  const content = (
    <section id={contentId} ref={contentRef} className="terminal-settings-content term-scrollbar" aria-label={label}
      key={`${page}:${target?.seq ?? 0}`}>
      <h1 ref={headingRef} tabIndex={-1} className="terminal-settings-heading">{label}</h1>
      <SettingsTargetContext.Provider value={target?.label ?? null}>
        <SectionContent>{body}</SectionContent>
      </SettingsTargetContext.Provider>
    </section>
  );

  if (stacked) return (
    <SettingsLayoutContext.Provider value="phone">
      <div className="terminal-settings terminal-settings--drawer" data-page={page} data-cards="" data-stacked="" data-view={view}>
        <div className="terminal-settings-layout">
          <aside className="terminal-settings-sidebar term-scrollbar">
            <PhoneSettingsMenu onOpen={(next) => openPage(next)} onNav={onNav} metaAgentAlert={metaAgentAlert} memoryPending={memoryPending} rowRef={setRowRef}
              history={workspaceReady ? history : { trash: 0, archived: 0 }} />
          </aside>
          {content}
        </div>
      </div>
    </SettingsLayoutContext.Provider>
  );
  return (
    <SettingsLayoutContext.Provider value="window">
      <div className="terminal-settings terminal-settings--window" data-page={page} data-cards="">
        <WindowNav page={page} query={query} onQuery={setQuery} onOpen={(next) => openPage(next)} onNav={onNav}
          onSubmit={() => { if (results[0]) pick(results[0]); }}
          history={workspaceReady ? history : { trash: 0, archived: 0 }} metaAgentAlert={metaAgentAlert} memoryPending={memoryPending} searchRef={searchRef} />
        {query.trim() ? <SearchResults query={query} results={results} onPick={pick} /> : content}
      </div>
    </SettingsLayoutContext.Provider>
  );
}
