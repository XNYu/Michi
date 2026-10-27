import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalTopbar from './Topbar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import { publishSpaceTopbar } from '../../state/pages/spaceTopbar';
import { readSpaceConversations, registerSpaceScope, resetSpaceConversationsForTests } from '../../state/spaceConversations/store';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }),
    triggerUpdate: vi.fn(),
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
    listModels: vi.fn().mockResolvedValue({ models: [], defaultModel: null }),
  };
});
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => null }));

const base = { onNav: () => {}, sidebarCollapsed: false, onToggleSidebar: () => {}, spacesAssistant: { open: false, onToggle: () => {} } };
const pageScope = { backendConnectionId: 'local', pageId: 'p1', workspaceId: 'w1', workspaceName: 'rabbitholes', pageTitle: 'Michi 0.9 发布' };

function renderTopbar(props: Partial<React.ComponentProps<typeof TerminalTopbar>> & { page: React.ComponentProps<typeof TerminalTopbar>['page'] }) {
  return render(<PrefsProvider><ChatProvider><TerminalTopbar {...base} {...props} /></ChatProvider></PrefsProvider>);
}

const crumb = () => document.querySelector('.terminal-topbar-breadcrumb')?.textContent?.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  window.localStorage.clear();
  resetSpaceConversationsForTests();
});
afterEach(() => { act(() => publishSpaceTopbar(null)); });

describe('Spaces topbar', () => {
  it('reads Spaces › workspace › page on a Space page, with Start a task and Open beside chat', () => {
    const onOpenBeside = vi.fn();
    act(() => { publishSpaceTopbar({ title: 'Michi 0.9 发布', onOpenBeside }); registerSpaceScope(pageScope); });
    renderTopbar({ page: 'space' });
    expect(crumb()).toBe('PAGES›rabbitholes›Michi 0.9 发布');

    const newChat = screen.getByRole('button', { name: 'Start a task from this page' });
    expect(newChat.textContent).toBe('Start a task');
    fireEvent.click(newChat);
    expect(readSpaceConversations().sheet).toMatchObject({ workspaceId: 'w1', text: '' });

    const beside = screen.getByRole('button', { name: 'Open beside chat' });
    expect(beside.textContent).toBe('Open beside chat');
    fireEvent.click(beside);
    expect(onOpenBeside).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Assistant' })).toBeTruthy();
  });

  it('reads Spaces › Home on Home, with Start a task but nothing to open beside the chat', () => {
    act(() => { registerSpaceScope({ ...pageScope, pageId: 'home', workspaceId: null, workspaceName: null, pageTitle: 'Home' }); });
    renderTopbar({ page: 'spaces', spacesCrumb: 'Home' });
    expect(crumb()).toBe('PAGES›Home');
    expect(screen.getByRole('button', { name: 'Start a task from this page' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open beside chat' })).toBeNull();
  });

  it('offers Start a task only where a page can show the sheet', () => {
    renderTopbar({ page: 'spaces', spacesCrumb: 'rabbitholes' });
    expect(crumb()).toBe('PAGES›rabbitholes');
    expect(screen.queryByRole('button', { name: 'Start a task from this page' })).toBeNull();
    act(() => { registerSpaceScope({ ...pageScope, pageId: 'ws-home' }); });
    expect(screen.getByRole('button', { name: 'Start a task from this page' })).toBeTruthy();
  });
});
