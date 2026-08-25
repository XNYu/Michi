import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import TerminalTopbar from './Topbar';
import { ChatProvider } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import { ConfirmDialogHost } from '../ui/ConfirmDialog';
import type { AppUpdateState, ElectronBridge } from '../../lib/electronBridge';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    listAgentModes: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({ models: [], defaultModel: null }),
  };
});

const listeners: Array<(state: AppUpdateState) => void> = [];
const downloadUpdate = vi.fn();
const installUpdate = vi.fn();
const getUpdateState = vi.fn();

const electron: ElectronBridge = {
  isPackaged: true,
  chooseFolder: vi.fn(),
  saveMarkdown: vi.fn(),
  getUpdateState,
  downloadUpdate,
  installUpdate,
  onAppUpdate(listener) {
    listeners.push(listener);
    return () => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    };
  },
};

vi.mock('../../lib/electronBridge', () => ({
  getElectron: () => electron,
}));

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <ChatProvider>
        <ConfirmDialogHost />
        {children}
      </ChatProvider>
    </PrefsProvider>
  );
}

const baseProps = {
  page: 'dashboard' as const,
  onNav: () => {},
  sidebarCollapsed: false,
  onToggleSidebar: () => {},
};

function emit(state: AppUpdateState): void {
  act(() => {
    for (const listener of listeners) listener(state);
  });
}

beforeEach(() => {
  listeners.length = 0;
  downloadUpdate.mockReset();
  installUpdate.mockReset();
  getUpdateState.mockReset().mockResolvedValue({
    status: 'idle',
    currentVersion: '0.2.1',
  });
  if (typeof window !== 'undefined') window.localStorage.clear();
});

describe('TerminalTopbar GitHub update badge', () => {
  it('shows a versioned badge when the main process reports an available release', async () => {
    render(
      <Wrap>
        <TerminalTopbar {...baseProps} />
      </Wrap>,
    );
    emit({ status: 'available', currentVersion: '0.2.1', latestVersion: '0.3.0' });
    expect(await screen.findByText('↑ Update to 0.3.0')).toBeTruthy();
  });

  it('downloads on click, then installs after confirm', async () => {
    downloadUpdate.mockResolvedValue({
      status: 'ready',
      currentVersion: '0.2.1',
      latestVersion: '0.3.0',
      percent: 100,
    });
    installUpdate.mockResolvedValue({
      status: 'installing',
      currentVersion: '0.2.1',
      latestVersion: '0.3.0',
    });

    render(
      <Wrap>
        <TerminalTopbar {...baseProps} />
      </Wrap>,
    );
    emit({ status: 'available', currentVersion: '0.2.1', latestVersion: '0.3.0' });
    fireEvent.click(await screen.findByText('↑ Update to 0.3.0'));

    await waitFor(() => expect(downloadUpdate).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Install and Restart' }));
    await waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
  });

  it('does not install when the confirm is cancelled', async () => {
    downloadUpdate.mockResolvedValue({
      status: 'ready',
      currentVersion: '0.2.1',
      latestVersion: '0.3.0',
    });

    render(
      <Wrap>
        <TerminalTopbar {...baseProps} />
      </Wrap>,
    );
    emit({ status: 'available', currentVersion: '0.2.1', latestVersion: '0.3.0' });
    fireEvent.click(await screen.findByText('↑ Update to 0.3.0'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(downloadUpdate).toHaveBeenCalledTimes(1));
    expect(installUpdate).not.toHaveBeenCalled();
  });
});
