import React, { useCallback, useId, useMemo } from 'react';
import type { PageId } from '../../../state/commands';
import type { ChatNodeState } from '../../../state/chatTypes';
import { useChatProjects, useStructuralSelector } from '../../../state/chatStore';
import { isArchiveGroupId } from '../../../state/trashActions';
import { isVisibleConversationNode } from '../../../state/conversationVisibility';
import { useAuthSession } from '../../../services/auth';
import { setManageWorkspaceId } from '../../../state/manageRoute';
import { SETTINGS_AREA_SECTIONS, type SettingsAreaSection } from '../../../state/shellArea';
import { AppearancePane } from '../pages/settings/AppearancePane';
import { ModelPane } from '../pages/settings/ModelPane';
import { NotificationsPane } from '../pages/settings/NotificationsPane';
import { ShortcutsPane } from '../pages/settings/ShortcutsPane';
import { AccountPane } from '../pages/settings/AccountPane';
import { ConnectionsPane } from '../pages/settings/ConnectionsPane';
import { BackgroundPane } from '../pages/settings/BackgroundPane';
import { BrowserSettingsPane } from '../pages/settings/BrowserSettingsPane';
import { MetaAgentSettings } from '../settings/metaAgent/MetaAgentSettings';
import { MichiAssistantSettings } from '../pages/settings/assistant/MichiAssistantSettings';
import { ComponentsSettings } from '../spaces/components/ComponentsSettings';
import '../pages/Settings.css';

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

/** Shared settings panes, with category navigation when hosted in the global drawer. */
export default function SettingsMain({ section, workspaceReady = true, onNav, onSectionChange }: {
  section: SettingsAreaSection;
  workspaceReady?: boolean;
  onNav: (page: PageId) => void;
  onSectionChange?: (section: SettingsAreaSection) => void;
}) {
  const { activeProject, projects } = useChatProjects();
  const session = useAuthSession();
  const history = useHistoryCounts();
  const label = SETTINGS_AREA_SECTIONS.find((item) => item.id === section)?.label ?? 'Settings';
  const contentId = useId();
  const waiting = <div role="status">Loading workspaces…</div>;
  let body: React.ReactNode;
  switch (section) {
    case 'general':
      body = workspaceReady ? <>
        <ConnectionsPane projects={projects} onOpenWorkspace={(id) => { setManageWorkspaceId(id); onNav('workspace-manage'); }} />
        <NotificationsPane />
        <BrowserSettingsPane />
        <BackgroundPane onOpenScheduled={() => onNav('scheduled')} />
        <ShortcutsPane />
        {session?.user && <AccountPane user={session.user} />}
      </> : waiting;
      break;
    case 'runtime':
      body = workspaceReady ? <ModelPane activeProjectId={activeProject?.id ?? null} /> : waiting;
      break;
    case 'assistant':
      body = workspaceReady ? <MichiAssistantSettings /> : waiting;
      break;
    case 'meta-agent':
      body = <MetaAgentSettings />;
      break;
    case 'components':
      body = workspaceReady ? <ComponentsSettings /> : waiting;
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
        <p className="area-settings__note">Backup and restore will be set here.</p>
      </>;
      break;
  }
  if (onSectionChange) return (
    <div className="terminal-settings terminal-settings--drawer" data-section={section}>
      <div className="terminal-settings-layout">
        <aside className="terminal-settings-sidebar term-scrollbar">
          <nav className="terminal-settings-categories" aria-label="Settings sections">
            {SETTINGS_AREA_SECTIONS.map(item => <button key={item.id} type="button" className="terminal-settings-category"
              aria-current={section === item.id ? 'page' : undefined} aria-controls={contentId} onClick={() => onSectionChange(item.id)}>
              {item.label}
            </button>)}
          </nav>
        </aside>
        <section id={contentId} className="terminal-settings-content term-scrollbar" aria-label={label} key={section}>
          <h1 className="terminal-settings-heading">{label}</h1>
          {body}
        </section>
      </div>
    </div>
  );
  return (
    <div className="terminal-settings area-settings term-scrollbar" data-section={section}>
      <section className="terminal-settings-content area-settings__doc" aria-label={label} key={section}>
        <p className="area-settings__kicker">Settings</p>
        <h1 className="area-settings__title">{label}</h1>
        {body}
      </section>
    </div>
  );
}
