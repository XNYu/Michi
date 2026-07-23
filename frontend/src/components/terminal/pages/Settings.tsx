import { useState } from 'react';
import { useChatStore, useStructuralSelector } from '../../../state/chatStore';
import { usePrefs } from '../../../state/prefs';
import type { PageId } from '../../../state/commands';
import { isArchiveGroupId } from '../../../state/trashActions';
import { Tab, BorderBtn } from '../primitives';
import { authClient } from '../../../services/auth';
import { AppearancePane } from './settings/AppearancePane';
import { ModelPane } from './settings/ModelPane';
import { NotificationsPane } from './settings/NotificationsPane';
import { ShortcutsPane } from './settings/ShortcutsPane';
import { AccountPane } from './settings/AccountPane';

type Section = 'model' | 'appearance' | 'shortcuts' | 'notifications' | 'account';

export default function TerminalSettings({
  onNav,
  onClose,
}: {
  onNav?: (p: PageId) => void;
  onClose?: () => void;
} = {}) {
  const [section, setSection] = useState<Section>('appearance');
  const { activeProject, projects } = useChatStore();
  const { resetTerminal } = usePrefs();

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

  // The Account tab only renders when the user is signed in. In desktop /
  // Electron mode useSession().data is null and we hide it entirely.
  const session = authClient.useSession();
  const signedIn = !!session.data?.user;

  const sections: Array<[Section, string]> = [
    ['model', 'Model'],
    ['appearance', 'Appearance'],
    ['notifications', 'Notifications'],
    ['shortcuts', 'Shortcuts'],
    ...(signedIn ? ([['account', 'Account']] as Array<[Section, string]>) : []),
  ];

  const openTrashPage = () => {
    onClose?.();
    onNav?.('trash');
  };

  const openArchivedPage = () => {
    onClose?.();
    onNav?.('archived');
  };

  return (
    <div
      className="term-scrollbar"
      style={{
        flex: 1,
        minHeight: 0,
        /* Transparent so the drawer's .term-glass frost shows through; individual
           controls keep their own solid surfaces (macOS-vibrancy panel look). */
        background: 'transparent',
        overflowY: 'auto',
        padding: '14px 16px 20px',
      }}
    >
      {/* horizontal tabs */}
      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--term-line)',
          marginBottom: 14,
          flexWrap: 'nowrap',
          whiteSpace: 'nowrap',
        }}
      >
        {sections.map(([k, l]) => {
          const active = section === k;
          return (
            <Tab
              key={k}
              focused={active}
              onClick={() => setSection(k)}
              style={{
                padding: '6px 7px',
                fontSize: 11,
                fontFamily: 'var(--ui-font)',
                color: active ? 'var(--term-fg)' : 'var(--term-mid)',
                borderBottom: active ? '2px solid var(--term-accent)' : '2px solid transparent',
                marginBottom: -1,
                fontWeight: active ? 600 : 400,
              }}
            >
              {l}
            </Tab>
          );
        })}
        <Tab
          focused={false}
          onClick={openTrashPage}
          style={{
            padding: '6px 7px',
            fontSize: 11,
            fontFamily: 'var(--ui-font)',
            color: 'var(--term-mid)',
            borderBottom: '2px solid transparent',
            marginBottom: -1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          Trash
          {trashCount > 0 && (
            <span
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 9.5,
                color: 'var(--term-surface)',
                background: 'var(--term-muted)',
                padding: '0 5px',
                minWidth: 16,
                textAlign: 'center',
                fontWeight: 700,
              }}
            >
              {trashCount}
            </span>
          )}
        </Tab>
        <Tab
          focused={false}
          onClick={openArchivedPage}
          style={{
            padding: '6px 7px',
            fontSize: 11,
            fontFamily: 'var(--ui-font)',
            color: 'var(--term-mid)',
            borderBottom: '2px solid transparent',
            marginBottom: -1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          Archived
          {archivedCount > 0 && (
            <span
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 9.5,
                color: 'var(--term-surface)',
                background: 'var(--term-muted)',
                padding: '0 5px',
                minWidth: 16,
                textAlign: 'center',
                fontWeight: 700,
              }}
            >
              {archivedCount}
            </span>
          )}
        </Tab>
      </div>

      <div>
        {section === 'appearance' && <AppearancePane />}
        {section === 'model' && (
          <ModelPane activeProjectId={activeProject?.id ?? null} />
        )}
        {section === 'notifications' && <NotificationsPane />}
        {section === 'shortcuts' && <ShortcutsPane />}
        {section === 'account' && signedIn && <AccountPane user={session.data!.user} />}

        {section === 'appearance' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <BorderBtn
              onClick={resetTerminal}
              style={{
                padding: '6px 14px',
                border: '1px solid var(--term-line)',
                color: 'var(--term-mid)',
                fontFamily: 'var(--ui-font)',
                fontSize: 11.5,
                background: 'transparent',
              }}
            >
              reset appearance
            </BorderBtn>
          </div>
        )}
      </div>
    </div>
  );
}
