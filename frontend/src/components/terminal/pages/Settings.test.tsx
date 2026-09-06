import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalSettings, { type SettingsSection } from './Settings';
import { DrawerShell } from '../../ui/DrawerShell';

const mocks = vi.hoisted(() => ({
  user: null as null | { name: string },
  mounted: vi.fn(),
  stopped: vi.fn(),
}));

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({ activeProject: { id: 'active' }, projects: [{ id: 'deleted', deletedAt: 1 }] }),
  useStructuralSelector: (selector: (nodes: unknown) => unknown) => selector({
    one: { deletionGroupId: 'trash-1' },
    two: { deletionGroupId: 'trash-1' },
    archived: { deletionGroupId: 'arch-1' },
  }),
}));
vi.mock('../../../services/auth', () => ({ authClient: { useSession: () => ({ data: mocks.user ? { user: mocks.user } : null }) } }));
// Preserve the real panes' title structure so a wrapper heading cannot silently duplicate it.
vi.mock('./settings/AppearancePane', () => ({ AppearancePane: () => <><h1>Appearance</h1><p>Appearance settings</p></> }));
vi.mock('./settings/ModelPane', () => ({ ModelPane: ({ activeProjectId }: { activeProjectId: string }) => <><h1>Model</h1><p>Model settings {activeProjectId}</p></> }));
vi.mock('./settings/ConnectionsPane', () => ({ ConnectionsPane: () => {
  React.useEffect(() => { mocks.mounted(); return mocks.stopped; }, []);
  return <><h1>Backend connections</h1><p>Connection settings</p></>;
} }));
vi.mock('./settings/NotificationsPane', () => ({ NotificationsPane: () => <><h1>Notifications</h1><p>Notification settings</p></> }));
vi.mock('./settings/ShortcutsPane', () => ({ ShortcutsPane: () => <><h1>Shortcuts</h1><p>Shortcut settings</p></> }));
vi.mock('./settings/AccountPane', () => ({ AccountPane: ({ user }: { user: { name: string } }) => <p>Account {user.name}</p> }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Settings navigation', () => {
  it.each([
    ['appearance', 'Appearance', 'Appearance', 1],
    ['model', 'Model', 'Model', 1],
    ['connections', 'Connections', 'Backend connections', 1],
    ['notifications', 'Notifications', 'Notifications', 1],
    ['shortcuts', 'Shortcuts', 'Shortcuts', 1],
    ['account', 'Account', 'Account', 2],
  ] as const)('renders exactly one category heading for %s', (section, regionName, title, level) => {
    mocks.user = { name: 'Ada' };
    render(<TerminalSettings section={section} />);
    const content = within(screen.getByRole('region', { name: regionName }));
    expect(content.getAllByRole('heading')).toHaveLength(1);
    expect(content.getByRole('heading', { name: title, level })).toBeTruthy();
  });

  it('exposes every category, separates History commands, and preserves history counts and actions', () => {
    const onClose = vi.fn();
    const onNav = vi.fn();
    render(<TerminalSettings onClose={onClose} onNav={onNav} />);
    const nav = screen.getByRole('navigation', { name: 'Settings categories' });
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Appearance', 'Model', 'Connections', 'Notifications', 'Shortcuts',
    ]);
    expect(screen.queryByRole('tab')).toBeNull();
    expect(within(nav).queryByText('Trash')).toBeNull();
    const history = screen.getByRole('group', { name: 'History' });
    fireEvent.click(within(history).getByRole('button', { name: 'Trash 2' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onNav).toHaveBeenCalledWith('trash');
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(onNav.mock.invocationCallOrder[0]);
    fireEvent.click(within(history).getByRole('button', { name: 'Archived 1' }));
    expect(onNav).toHaveBeenLastCalledWith('archived');
  });

  it('switches categories from the compact select', () => {
    render(<TerminalSettings />);
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'model' } });
    expect(screen.getByText('Model settings active')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Model' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('group', { name: 'History' })).toBeNull();
  });

  it('shows Account only when signed in, and renders Appearance instead of a blank pane on sign-out', () => {
    mocks.user = { name: 'Ada' };
    const { rerender } = render(<TerminalSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByText('Account Ada')).toBeTruthy();
    mocks.user = null;
    rerender(<TerminalSettings />);
    expect(screen.queryByRole('button', { name: 'Account' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Account' })).toBeNull();
    expect(screen.getByText('Appearance settings')).toBeTruthy();
    expect((screen.getByLabelText('Category') as HTMLSelectElement).value).toBe('appearance');
  });

  it('retains a shell-controlled category across close while releasing its effects', () => {
    vi.useFakeTimers();
    function Harness({ open }: { open: boolean }) {
      const [section, setSection] = React.useState<SettingsSection>('appearance');
      return <DrawerShell open={open} onClose={() => {}} width={620} title="Settings">
        <TerminalSettings section={section} onSectionChange={setSection} />
      </DrawerShell>;
    }
    const { rerender } = render(<Harness open />);
    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    expect(mocks.mounted).toHaveBeenCalledTimes(1);
    rerender(<Harness open={false} />);
    act(() => vi.advanceTimersByTime(200));
    expect(mocks.stopped).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Connection settings')).toBeNull();
    rerender(<Harness open />);
    expect(screen.getByText('Connection settings')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connections' }).getAttribute('aria-current')).toBe('page');
    expect(mocks.mounted).toHaveBeenCalledTimes(2);
  });

});
