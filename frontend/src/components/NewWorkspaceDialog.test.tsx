import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewWorkspaceDialog from './NewWorkspaceDialog';
import { setKnownBackendConnections } from '../config/backendConnections';

let mockElectron: {
  chooseFolder: () => Promise<{ canceled: boolean; path?: string; name?: string }>;
} | null = null;

vi.mock('../lib/electronBridge', () => ({
  getElectron: () => mockElectron,
}));

vi.mock('../services/api', () => ({
  listBackendConnections: vi.fn().mockResolvedValue([]),
}));

function renderDialog(overrides: Partial<React.ComponentProps<typeof NewWorkspaceDialog>> = {}) {
  const props: React.ComponentProps<typeof NewWorkspaceDialog> = {
    open: true,
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
  render(<NewWorkspaceDialog {...props} />);
  return props;
}

describe('NewWorkspaceDialog multi-folder', () => {
  afterEach(() => {
    mockElectron = null;
    setKnownBackendConnections([]);
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it('adds a folder from Electron picker and shows it in the list', async () => {
    mockElectron = {
      chooseFolder: vi.fn().mockResolvedValue({
        canceled: false,
        path: '/Users/demo/project',
        name: 'project',
      }),
    };
    renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByText(/Add folders the agent can read and edit/i));
    });

    // Should show the folder name, path, and Primary badge
    expect(screen.getByText('project')).toBeTruthy();
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(screen.getByText('/Users/demo/project')).toBeTruthy();
  });

  it('passes folders to onCreate when creating', async () => {
    mockElectron = {
      chooseFolder: vi.fn().mockResolvedValue({
        canceled: false,
        path: '/Users/demo/project',
        name: 'project',
      }),
    };
    const props = renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByText(/Add folders the agent can read and edit/i));
    });

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(props.onCreate).toHaveBeenCalledWith(
      'project',
      '/Users/demo/project',
      expect.arrayContaining([
        expect.objectContaining({ path: '/Users/demo/project', label: 'project' }),
      ]),
    );
  });

  it('rejects nested folders with an error message', async () => {
    let callCount = 0;
    mockElectron = {
      chooseFolder: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { canceled: false, path: '/a', name: 'a' };
        return { canceled: false, path: '/a/sub', name: 'sub' };
      }),
    };
    renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByText(/Add folders the agent can read and edit/i));
    });
    await act(async () => {
      const addBtn = screen.getByText((_content, el) =>
        el?.tagName === 'BUTTON' && el.textContent === '+ Add folder',
      );
      fireEvent.click(addBtn);
    });

    expect(screen.getByText(/overlaps with an existing folder/i)).toBeTruthy();
    // Second folder should NOT be added
    expect(screen.queryByText('sub')).toBeNull();
  });

  it('allows removing a non-primary folder', async () => {
    let callCount = 0;
    mockElectron = {
      chooseFolder: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return { canceled: false, path: '/a/first', name: 'first' };
        return { canceled: false, path: '/b/second', name: 'second' };
      }),
    };
    renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByText(/Add folders the agent can read and edit/i));
    });
    await act(async () => {
      const addBtn = screen.getByText((_content, el) =>
        el?.tagName === 'BUTTON' && el.textContent === '+ Add folder',
      );
      fireEvent.click(addBtn);
    });

    expect(screen.getByText('second')).toBeTruthy();

    // Both folders have a × remove button
    const removeButtons = screen.getAllByTitle('Remove folder');
    fireEvent.click(removeButtons[1]);

    expect(screen.queryByText('second')).toBeNull();
    expect(screen.getByText('first')).toBeTruthy();
  });

  it('creates without folders when none are added', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(props.onCreate).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it('labels the skip path as quick chat', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /open quick chat/i }));
    expect(props.onSkip).toHaveBeenCalledTimes(1);
  });

  it('creates a workspace against a remote backend path', async () => {
    setKnownBackendConnections([{
      id: 'remote-1',
      name: 'Build server',
      transport: 'direct',
      apiUrl: 'https://build.example.com/api',
      hasToken: true,
      createdAt: 1,
      updatedAt: 1,
    }]);
    const props = renderDialog();
    fireEvent.change(screen.getByLabelText('Backend connection'), { target: { value: 'remote-1' } });
    fireEvent.change(screen.getByPlaceholderText('/home/you/project'), { target: { value: '/srv/project' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(props.onCreate).toHaveBeenCalledWith(
      'project',
      '/srv/project',
      [expect.objectContaining({ path: '/srv/project' })],
      'remote-1',
    );
    expect(screen.queryByRole('button', { name: /open quick chat/i })).toBeNull();
  });

  it('shows browser fallback notice when using showDirectoryPicker', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'browser-project' }),
    });
    renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByText(/Add folders the agent can read and edit/i));
    });

    expect(screen.getByRole('status').textContent).toContain('cannot link absolute local folders');
  });
});
