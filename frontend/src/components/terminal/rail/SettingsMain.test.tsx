import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import SettingsMain from './SettingsMain';

const store = vi.hoisted(() => ({
  metaAgentAlert: false,
  projects: [] as Array<{ id: string; deletedAt?: number }>,
  nodes: {} as Record<string, { nodeId: string; projectId: string; deletionGroupId?: string; pageId?: string | null }>,
}));
vi.mock('../../../state/metaAgent/useMetaAgentOverview', () => ({ useMetaAgentSettingsAlert: () => store.metaAgentAlert }));
vi.mock('../settings/metaAgent/MetaAgentSettings', () => ({ MetaAgentSettings: () => <div>Meta agent settings</div> }));

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

it('has no Assistant section: the assistant follows the global runtime settings', () => {
  render(<SettingsMain section="data" onNav={vi.fn()} onSectionChange={vi.fn()} />);
  const sections = screen.getByRole('navigation', { name: 'Settings sections' });
  expect(within(sections).queryByRole('button', { name: 'Assistant' })).toBeNull();
  expect(within(sections).getByRole('button', { name: 'Runtime (global)' })).toBeTruthy();
});

it('identifies the category needing attention, keeps its dot when selected, and clears it after recovery', () => {
  store.metaAgentAlert = true;
  const onSectionChange = vi.fn();
  const props = { onNav: vi.fn(), onSectionChange };
  const view = render(<SettingsMain {...props} section="data" />);
  const category = screen.getByRole('button', { name: 'Meta agent, needs attention' });
  expect(category.querySelector('.terminal-settings-alert')).toBeTruthy();
  expect(document.querySelectorAll('.terminal-settings-alert')).toHaveLength(1);
  fireEvent.click(category);
  expect(onSectionChange).toHaveBeenCalledWith('meta-agent');
  view.rerender(<SettingsMain {...props} section="meta-agent" />);
  expect(screen.getByRole('button', { name: 'Meta agent, needs attention' }).getAttribute('aria-current')).toBe('page');
  expect(document.querySelector('.terminal-settings-alert')).toBeTruthy();
  store.metaAgentAlert = false;
  view.rerender(<SettingsMain {...props} section="meta-agent" />);
  expect(screen.getByRole('button', { name: 'Meta agent' })).toBeTruthy();
  expect(document.querySelector('.terminal-settings-alert')).toBeNull();
});

describe('Settings levels in a stacked (phone) drawer', () => {
  beforeEach(() => {
    store.metaAgentAlert = false;
    store.projects = [];
    store.nodes = {};
  });
  const root = () => document.querySelector('.terminal-settings--drawer')!;

  it('asks for the section level when a row is picked and moves focus to its heading, then back to the row', () => {
    const onSectionChange = vi.fn();
    const onViewChange = vi.fn();
    const props = { onNav: vi.fn(), onSectionChange, onViewChange, stacked: true };
    const view = render(<SettingsMain {...props} section="data" view="menu" />);
    expect(root().getAttribute('data-view')).toBe('menu');
    expect(root().hasAttribute('data-stacked')).toBe(true);
    expect(root().querySelectorAll('.terminal-settings-category__chevron')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Meta agent' }));
    expect(onViewChange).toHaveBeenCalledWith('section');
    expect(onSectionChange).toHaveBeenCalledWith('meta-agent');
    view.rerender(<SettingsMain {...props} section="meta-agent" view="section" />);
    expect(root().getAttribute('data-view')).toBe('section');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Meta agent' }));
    // The host's header Back returns to the list.
    view.rerender(<SettingsMain {...props} section="meta-agent" view="menu" />);
    expect(root().getAttribute('data-view')).toBe('menu');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Meta agent' }));
  });

  it('keeps the list beside the section and focus on the row when not stacked', () => {
    const onViewChange = vi.fn();
    const props = { onNav: vi.fn(), onSectionChange: vi.fn(), onViewChange };
    const view = render(<SettingsMain {...props} section="data" view="menu" />);
    expect(root().hasAttribute('data-view')).toBe(false);
    expect(root().querySelector('.terminal-settings-category__chevron')).toBeNull();
    const row = screen.getByRole('button', { name: 'Meta agent' });
    row.focus();
    fireEvent.click(row);
    view.rerender(<SettingsMain {...props} section="meta-agent" view="section" />);
    expect(root().hasAttribute('data-view')).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Meta agent' }));
  });
});
