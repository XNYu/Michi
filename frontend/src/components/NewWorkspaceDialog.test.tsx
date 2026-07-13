import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewWorkspaceDialog from './NewWorkspaceDialog';

let mockElectron: {
  chooseFolder: () => Promise<{ canceled: boolean; path?: string; name?: string }>;
} | null = null;

vi.mock('../lib/electronBridge', () => ({
  getElectron: () => mockElectron,
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

describe('NewWorkspaceDialog folder semantics', () => {
  afterEach(() => {
    mockElectron = null;
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it('treats a browser directory selection as naming-only', async () => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: vi.fn().mockResolvedValue({ name: 'browser-project' }),
    });
    const props = renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /browse/i }));
    });

    expect(screen.getByRole('status').textContent).toContain('cannot link an absolute local folder');
    fireEvent.click(screen.getByRole('button', { name: /create without folder/i }));
    expect(props.onCreate).toHaveBeenCalledWith('browser-project', undefined);
  });

  it('passes an absolute Electron folder through to workspace creation', async () => {
    mockElectron = {
      chooseFolder: vi.fn().mockResolvedValue({
        canceled: false,
        path: '/Users/demo/project',
        name: 'project',
      }),
    };
    const props = renderDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /browse/i }));
    });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(props.onCreate).toHaveBeenCalledWith('project', '/Users/demo/project');
  });

  it('labels the skip path as quick chat', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /open quick chat/i }));
    expect(props.onSkip).toHaveBeenCalledTimes(1);
  });
});
