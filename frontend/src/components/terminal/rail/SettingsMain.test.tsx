import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SettingsMain from './SettingsMain';

const store = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; deletedAt?: number }>,
  nodes: {} as Record<string, { nodeId: string; projectId: string; deletionGroupId?: string; pageId?: string | null }>,
}));
vi.mock('../pages/settings/assistant/MichiAssistantSettings', () => ({ MichiAssistantSettings: () => <div>Native assistant settings</div> }));

vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({ activeProject: null, projects: store.projects }),
    useStructuralSelector: (selector: (nodes: typeof store.nodes) => unknown) => selector(store.nodes),
  };
});

const link = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}$`) });
const description = (button: HTMLElement) => document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent ?? null;

describe('Settings › Data & backup', () => {
  beforeEach(() => {
    store.projects = [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-gone', deletedAt: 5 }];
    store.nodes = {
      a: { nodeId: 'a', projectId: 'ws-1', deletionGroupId: 'del-1' },
      b: { nodeId: 'b', projectId: 'ws-1', deletionGroupId: 'del-1' },
      c: { nodeId: 'c', projectId: 'ws-2', deletionGroupId: 'del-2' },
      helper: { nodeId: 'helper', projectId: 'ws-2', deletionGroupId: 'del-3', pageId: 'page-1' },
      gone: { nodeId: 'gone', projectId: 'ws-gone', deletionGroupId: 'del-4' },
      kept: { nodeId: 'kept', projectId: 'ws-1' },
      arch: { nodeId: 'arch', projectId: 'ws-1', deletionGroupId: 'arch-1' },
    };
  });

  it('shows how many entries Trash and Archived hold, and opens them', () => {
    const onNav = vi.fn();
    render(<SettingsMain section="data" onNav={onNav} />);
    // Two deleted thread groups plus one deleted workspace; the page helper is not a thread.
    expect(link('Trash').textContent).toBe('Trash3');
    expect(description(link('Trash'))).toBe('3');
    expect(link('Archived').textContent).toBe('Archived1');
    expect(description(link('Archived'))).toBe('1');
    fireEvent.click(link('Trash'));
    fireEvent.click(link('Archived'));
    expect(onNav.mock.calls).toEqual([['trash'], ['archived']]);
  });

  it('shows no count for empty lists or before workspaces load', () => {
    store.projects = [{ id: 'ws-1' }];
    store.nodes = { kept: { nodeId: 'kept', projectId: 'ws-1' } };
    const { unmount } = render(<SettingsMain section="data" onNav={vi.fn()} />);
    expect(link('Trash').textContent).toBe('Trash');
    expect(link('Trash').hasAttribute('aria-describedby')).toBe(false);
    expect(link('Archived').textContent).toBe('Archived');
    unmount();
    store.nodes = { a: { nodeId: 'a', projectId: 'ws-1', deletionGroupId: 'del-1' } };
    render(<SettingsMain section="data" workspaceReady={false} onNav={vi.fn()} />);
    expect(link('Trash').textContent).toBe('Trash');
  });
});

it('opens the native Assistant settings from the Settings area', () => {
  render(<SettingsMain section="assistant" onNav={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Assistant' })).toBeTruthy();
  expect(screen.getByText('Native assistant settings')).toBeTruthy();
});
