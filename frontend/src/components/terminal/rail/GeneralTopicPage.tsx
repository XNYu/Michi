import type { PageId } from '../../../state/commands';
import { useChatProjects } from '../../../state/chatStore';
import { setManageWorkspaceId } from '../../../state/manageRoute';
import { useAuthSession } from '../../../services/auth';
import { ConnectionsPane } from '../pages/settings/ConnectionsPane';
import { NotificationsPane } from '../pages/settings/NotificationsPane';
import { BrowserSettingsPane } from '../pages/settings/BrowserSettingsPane';
import { BackgroundPane } from '../pages/settings/BackgroundPane';
import { ShortcutsPane } from '../pages/settings/ShortcutsPane';
import { AccountPane } from '../pages/settings/AccountPane';
import type { SettingsPage } from './settingsPages';

/** One of the pages the older General section held together, on its own. */
export default function GeneralTopicPage({ page, workspaceReady, onNav }: {
  page: SettingsPage;
  workspaceReady: boolean;
  onNav: (page: PageId) => void;
}) {
  const { projects } = useChatProjects();
  const session = useAuthSession();
  switch (page) {
    case 'machines':
      return workspaceReady ? <ConnectionsPane projects={projects}
        onOpenWorkspace={id => { setManageWorkspaceId(id); onNav('workspace-manage'); }} />
        : <div role="status">Loading workspaces…</div>;
    case 'notifications': return <NotificationsPane />;
    case 'links': return <BrowserSettingsPane />;
    case 'scheduled': return <BackgroundPane onOpenScheduled={() => onNav('scheduled')} />;
    case 'shortcuts': return <ShortcutsPane />;
    case 'account': return session?.user ? <AccountPane user={session.user} /> : <p className="settings-section__status">Not signed in.</p>;
    default: return null;
  }
}
