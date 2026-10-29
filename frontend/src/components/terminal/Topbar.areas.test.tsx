import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TerminalTopbar from './Topbar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    checkVersion: vi.fn().mockResolvedValue({ updateAvailable: false }),
    triggerUpdate: vi.fn(),
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
  };
});
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => null }));

const base = { onNav: () => {}, sidebarCollapsed: false, onToggleSidebar: () => {} };

function renderTopbar(props: Partial<React.ComponentProps<typeof TerminalTopbar>> & { page: React.ComponentProps<typeof TerminalTopbar>['page'] }) {
  return render(<PrefsProvider><ChatProvider><TerminalTopbar {...base} {...props} /></ChatProvider></PrefsProvider>);
}

const crumb = () => document.querySelector('.terminal-topbar-breadcrumb')?.textContent?.replace(/\s+/g, ' ').trim();

beforeEach(() => { window.localStorage.clear(); });

describe('Settings and Scheduled topbar', () => {
  it('reads Settings › the open section', () => {
    renderTopbar({ page: 'settings', areaCrumb: 'Meta agent' });
    expect(crumb()).toBe('SETTINGS›Meta agent');
  });

  it('reads Scheduled › Meta agent · Maintain Spaces on its page, and Scheduled alone on the job list', () => {
    const view = renderTopbar({ page: 'scheduled', areaCrumb: 'Meta agent · Maintain Pages' });
    expect(crumb()).toBe('SCHEDULED›Meta agent · Maintain Pages');
    view.unmount();
    renderTopbar({ page: 'scheduled' });
    expect(crumb()).toBe('SCHEDULED');
  });
});
