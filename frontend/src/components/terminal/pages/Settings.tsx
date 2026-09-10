import { useId, useState } from 'react';
import { useChatStore, useStructuralSelector } from '../../../state/chatStore';
import type { PageId } from '../../../state/commands';
import { isArchiveGroupId } from '../../../state/trashActions';
import { useAuthSession } from '../../../services/auth';
import { AppearancePane } from './settings/AppearancePane';
import { ModelPane } from './settings/ModelPane';
import { NotificationsPane } from './settings/NotificationsPane';
import { ShortcutsPane } from './settings/ShortcutsPane';
import { AccountPane } from './settings/AccountPane';
import { ConnectionsPane } from './settings/ConnectionsPane';
import './Settings.css';

export type SettingsSection = 'model' | 'connections' | 'appearance' | 'shortcuts' | 'notifications' | 'account';

export default function TerminalSettings({
  onNav,
  onClose,
  section: controlledSection,
  onSectionChange,
}: {
  onNav?: (p: PageId) => void;
  onClose?: () => void;
  section?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
} = {}) {
  const [localSection, setLocalSection] = useState<SettingsSection>('appearance');
  const contentId = useId();
  const { activeProject, projects } = useChatStore();

  const trashGroupCount = useStructuralSelector((nodesMap) => {
    const gids = new Set<string>();
    for (const n of Object.values(nodesMap)) {
      if (n.deletionGroupId && !isArchiveGroupId(n.deletionGroupId)) gids.add(n.deletionGroupId);
    }
    return gids.size;
  });
  const trashCount = trashGroupCount + projects.filter((p) => p.deletedAt).length;
  const archivedCount = useStructuralSelector((nodesMap) => {
    const gids = new Set<string>();
    for (const n of Object.values(nodesMap)) {
      if (isArchiveGroupId(n.deletionGroupId)) gids.add(n.deletionGroupId!);
    }
    return gids.size;
  });

  // The Account category only renders when the user is signed in. In desktop /
  // Electron mode has no session subscription or account category.
  const session = useAuthSession();
  const signedIn = !!session?.user;

  const selectedSection = controlledSection ?? localSection;
  const section = selectedSection === 'account' && !signedIn ? 'appearance' : selectedSection;
  const setSection = (next: SettingsSection) => {
    setLocalSection(next);
    onSectionChange?.(next);
  };
  const sections: Array<[SettingsSection, string]> = [
    ['appearance', 'Appearance'],
    ['model', 'Model'],
    ['connections', 'Connections'],
    ['notifications', 'Notifications'],
    ['shortcuts', 'Shortcuts'],
    ...(signedIn ? ([['account', 'Account']] as Array<[SettingsSection, string]>) : []),
  ];
  const sectionLabel = sections.find(([key]) => key === section)?.[1];

  const openTrashPage = () => {
    onClose?.();
    onNav?.('trash');
  };

  const openArchivedPage = () => {
    onClose?.();
    onNav?.('archived');
  };

  return (
    <div className="terminal-settings">
      <div className="terminal-settings-layout">
        <aside className="terminal-settings-sidebar term-scrollbar">
          <nav className="terminal-settings-categories" aria-label="Settings categories">
            {sections.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className="terminal-settings-category"
                aria-current={section === key ? 'page' : undefined}
                aria-controls={contentId}
                onClick={() => setSection(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          {onNav && (
            <div className="terminal-settings-history" role="group" aria-label="History">
              <h2>History</h2>
              <button type="button" className="terminal-settings-history-command" onClick={openTrashPage}>
                Trash
                {trashCount > 0 && <span className="terminal-settings-count">{trashCount}</span>}
              </button>
              <button type="button" className="terminal-settings-history-command" onClick={openArchivedPage}>
                Archived
                {archivedCount > 0 && <span className="terminal-settings-count">{archivedCount}</span>}
              </button>
            </div>
          )}
        </aside>

        <section className="terminal-settings-content term-scrollbar" id={contentId} aria-label={sectionLabel} key={section}>
          {section === 'account' && <h2 className="terminal-settings-heading">Account</h2>}
          {section === 'appearance' && <AppearancePane />}
          {section === 'model' && <ModelPane activeProjectId={activeProject?.id ?? null} />}
          {section === 'connections' && <ConnectionsPane projects={projects} />}
          {section === 'notifications' && <NotificationsPane />}
          {section === 'shortcuts' && <ShortcutsPane />}
          {section === 'account' && signedIn && <AccountPane user={session!.user} />}
        </section>
      </div>
    </div>
  );
}
