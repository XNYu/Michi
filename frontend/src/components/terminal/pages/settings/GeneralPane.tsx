import type { PageId } from '../../../../state/commands';
import { useChatProjects } from '../../../../state/chatStore';
import { useAuthSession } from '../../../../services/auth';
import { setManageWorkspaceId } from '../../../../state/manageRoute';
import { ConnectionsPane } from './ConnectionsPane';
import { NotificationsPane } from './NotificationsPane';
import { BrowserSettingsPane } from './BrowserSettingsPane';
import { BackgroundPane } from './BackgroundPane';
import { ShortcutsPane } from './ShortcutsPane';
import { AccountPane } from './AccountPane';

export default function GeneralPane({ onNav }: { onNav: (page: PageId) => void }) {
  const { projects } = useChatProjects();
  const session = useAuthSession();
  return <>
    <ConnectionsPane projects={projects} onOpenWorkspace={id => { setManageWorkspaceId(id); onNav('workspace-manage'); }} />
    <NotificationsPane />
    <BrowserSettingsPane />
    <BackgroundPane onOpenScheduled={() => onNav('scheduled')} />
    <ShortcutsPane />
    {session?.user && <AccountPane user={session.user} />}
  </>;
}
