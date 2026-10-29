import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { PageId } from '../../../state/commands';
import type { ChatNodeState } from '../../../state/chatTypes';
import { useChatProjects, useStructuralSelector } from '../../../state/chatStore';
import { isArchiveGroupId } from '../../../state/trashActions';
import { isVisibleConversationNode } from '../../../state/conversationVisibility';
import { SETTINGS_AREA_SECTIONS, type SettingsAreaSection } from '../../../state/shellArea';
import { useMetaAgentSettingsAlert } from '../../../state/metaAgent/useMetaAgentOverview';
import { AppearancePane } from '../pages/settings/AppearancePane';
import '../pages/Settings.css';

// Keep the drawer and local appearance controls ready with the shell. Other
// categories load only when selected, without suspending the navigation.
const GeneralPane = React.lazy(() => import('../pages/settings/GeneralPane'));
const ModelPane = React.lazy(() => import('../pages/settings/ModelPane').then(module => ({ default: module.ModelPane })));
const MetaAgentSettings = React.lazy(() => import('../settings/metaAgent/MetaAgentSettings').then(module => ({ default: module.MetaAgentSettings })));
const BackupPane = React.lazy(() => import('../pages/settings/BackupPane').then(module => ({ default: module.BackupPane })));

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

/** A Data & backup link; its count is the description, so the name stays the place's own. */
function HistoryLink({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  const countId = useId();
  return (
    <button type="button" className="terminal-settings-history-command" aria-describedby={count > 0 ? countId : undefined} onClick={onClick}>
      {label}
      {count > 0 && <span id={countId} className="terminal-settings-count" aria-hidden="true">{count}</span>}
    </button>
  );
}

export type SettingsLevel = 'menu' | 'section';

/**
 * Shared settings panes, with category navigation when hosted in the global drawer.
 *
 * A `stacked` drawer (one that fills a phone screen) shows one level at a
 * time, like a phone's own settings: the section list, then the chosen
 * section alone. The host owns the level (`view`) so its header Back can
 * return from a section to the list; picking a section asks for 'section'.
 * Unstacked drawers keep the list beside the section and ignore the level.
 */
export default function SettingsMain({ section, workspaceReady = true, onNav, onSectionChange, view: hostView, onViewChange, stacked = false }: {
  section: SettingsAreaSection;
  workspaceReady?: boolean;
  onNav: (page: PageId) => void;
  onSectionChange?: (section: SettingsAreaSection) => void;
  view?: SettingsLevel;
  onViewChange?: (view: SettingsLevel) => void;
  stacked?: boolean;
}) {
  const { activeProject } = useChatProjects();
  const history = useHistoryCounts();
  const metaAgentAlert = useMetaAgentSettingsAlert();
  const label = SETTINGS_AREA_SECTIONS.find((item) => item.id === section)?.label ?? 'Settings';
  const contentId = useId();
  const [ownView, setOwnView] = useState<SettingsLevel>('menu');
  const view = hostView ?? ownView;
  // Switching level in a stacked drawer hides what has focus (the picked row,
  // or the section the header Back left), so focus follows: to the section's
  // heading, or back to the row of the section just left.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const categoryRefs = useRef(new Map<SettingsAreaSection, HTMLButtonElement>());
  const previousView = useRef(view);
  useEffect(() => {
    const previous = previousView.current;
    previousView.current = view;
    if (!stacked || previous === view) return;
    if (view === 'section') headingRef.current?.focus({ preventScroll: true });
    else categoryRefs.current.get(section)?.focus({ preventScroll: true });
  }, [view, stacked, section]);
  const openSection = (next: SettingsAreaSection) => {
    setOwnView('section');
    onViewChange?.('section');
    onSectionChange?.(next);
  };
  const waiting = <div role="status">Loading workspaces…</div>;
  let body: React.ReactNode;
  switch (section) {
    case 'general':
      body = workspaceReady ? <GeneralPane onNav={onNav} /> : waiting;
      break;
    case 'runtime':
      body = workspaceReady ? <ModelPane activeProjectId={activeProject?.id ?? null} /> : waiting;
      break;
    case 'meta-agent':
      body = <MetaAgentSettings />;
      break;
    case 'appearance':
      body = <AppearancePane />;
      break;
    case 'data':
      body = <>
        <div className="area-settings__links">
          <HistoryLink label="Trash" count={workspaceReady ? history.trash : 0} onClick={() => onNav('trash')} />
          <HistoryLink label="Archived" count={workspaceReady ? history.archived : 0} onClick={() => onNav('archived')} />
        </div>
        {workspaceReady ? <SectionContent><BackupPane /></SectionContent> : waiting}
      </>;
      break;
  }
  if (onSectionChange) return (
    <div className="terminal-settings terminal-settings--drawer" data-section={section}
      data-stacked={stacked || undefined} data-view={stacked ? view : undefined}>
      <div className="terminal-settings-layout">
        <aside className="terminal-settings-sidebar term-scrollbar">
          <nav className="terminal-settings-categories" aria-label="Settings sections">
            {SETTINGS_AREA_SECTIONS.map(item => <button key={item.id} type="button" className="terminal-settings-category"
              ref={(button) => { if (button) categoryRefs.current.set(item.id, button); else categoryRefs.current.delete(item.id); }}
              aria-label={item.id === 'meta-agent' && metaAgentAlert ? `${item.label}, needs attention` : undefined}
              aria-current={section === item.id ? 'page' : undefined} aria-controls={contentId} onClick={() => openSection(item.id)}>
              {item.label}
              {item.id === 'meta-agent' && metaAgentAlert && <span className="terminal-settings-alert" aria-hidden="true" />}
              {stacked && <ChevronRight className="terminal-settings-category__chevron" size={16} strokeWidth={1.75} aria-hidden="true" />}
            </button>)}
          </nav>
        </aside>
        <section id={contentId} className="terminal-settings-content term-scrollbar" aria-label={label} key={section}>
          <h1 ref={headingRef} tabIndex={-1} className="terminal-settings-heading">{label}</h1>
          <SectionContent>{body}</SectionContent>
        </section>
      </div>
    </div>
  );
  return (
    <div className="terminal-settings area-settings term-scrollbar" data-section={section}>
      <section className="terminal-settings-content area-settings__doc" aria-label={label} key={section}>
        <p className="area-settings__kicker">Settings</p>
        <h1 className="area-settings__title">{label}</h1>
        <SectionContent>{body}</SectionContent>
      </section>
    </div>
  );
}
