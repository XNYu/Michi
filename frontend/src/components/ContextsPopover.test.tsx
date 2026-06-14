import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ContextsPopover from './ContextsPopover';
import type { ContextEntry } from '../state/chatStore';

// Mock api module so importWorkspaceFileUpload can be spied on.
// vi.hoisted ensures the fn is created before the hoisted vi.mock factory runs.
const { mockImportWorkspaceFileUpload } = vi.hoisted(() => ({
  mockImportWorkspaceFileUpload: vi.fn(),
}));
vi.mock('../services/api', () => ({
  importWorkspaceFileUpload: mockImportWorkspaceFileUpload,
}));

// Mock chatStore to inject contexts and capture action calls.
const mockActions = {
  createContext: vi.fn(),
  updateContext: vi.fn(),
  deleteContext: vi.fn(),
  toggleAutoInject: vi.fn(),
};

const mockContexts: ContextEntry[] = [];
const mockProject = { id: 'p1', name: 'P1', cwd: '/tmp/p1', contexts: mockContexts };

vi.mock('../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../state/chatStore');
  return {
    ...actual,
    useChatStore: () => ({ activeProject: mockProject, ...mockActions }),
  };
});

beforeEach(() => {
  mockContexts.length = 0;
  Object.values(mockActions).forEach((fn) => fn.mockReset());
  mockImportWorkspaceFileUpload.mockReset();
  mockImportWorkspaceFileUpload.mockResolvedValue({ name: 'doc', filePath: '.contexts/doc.md', size: 5 });
});

const anchorRect = { top: 40, left: 100, right: 140, bottom: 60, width: 40, height: 20, x: 100, y: 40, toJSON: () => ({}) } as DOMRect;

describe('ContextsPopover', () => {
  it('renders empty state when no contexts', () => {
    render(<ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={() => {}} />);
    expect(screen.getByText(/no contexts yet/i)).toBeTruthy();
  });

  it('renders context rows with relative time', () => {
    const now = Date.now();
    mockContexts.push({
      id: 'c1', name: 'design-doc', filePath: '/abs/design-doc.md',
      kind: 'reference', source: 'user', autoInject: true,
      createdAt: now - 5 * 60_000, updatedAt: now - 5 * 60_000,
    });
    render(<ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={() => {}} />);
    expect(screen.getByText('design-doc')).toBeTruthy();
    expect(screen.getByText('5m')).toBeTruthy();
    expect(screen.getByTitle(/auto-inject/i)).toBeTruthy();
  });

  it('shows ↗ marker for reference entries', () => {
    mockContexts.push({
      id: 'c1', name: 'spec', filePath: '/abs/spec.md',
      kind: 'reference', source: 'user',
      createdAt: 0, updatedAt: Date.now(),
    });
    render(<ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={() => {}} />);
    expect(screen.getByText('↗')).toBeTruthy();
  });

  it('shows agent tag for agent-sourced entries', () => {
    mockContexts.push({
      id: 'c1', name: 'gen', filePath: '.contexts/gen.md',
      source: 'agent',
      createdAt: 0, updatedAt: Date.now(),
    });
    render(<ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={() => {}} />);
    expect(screen.getByText('agent')).toBeTruthy();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    render(<ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on outside mousedown', () => {
    const onClose = vi.fn();
    render(
      <div>
        <ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={onClose} />
        <div data-testid="outside">outside</div>
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onClose when mousedown is inside the popover', () => {
    const onClose = vi.fn();
    render(<ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText(/no contexts yet/i));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT close on mousedown over the anchor element', () => {
    const onClose = vi.fn();
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    try {
      render(<ContextsPopover anchorRect={anchorRect} anchorEl={anchor} onClose={onClose} />);
      fireEvent.mouseDown(anchor);
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      anchor.remove();
    }
  });

  it('+ button uses electron.chooseFiles when available and creates references', async () => {
    const chooseFiles = vi.fn().mockResolvedValue({
      canceled: false, paths: ['/abs/foo.md', '/abs/bar.json'],
    });
    (window as any).electron = { chooseFiles };
    try {
      render(<ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={() => {}} />);
      const addBtn = screen.getByTitle(/add context/i);
      await act(async () => { fireEvent.click(addBtn); });
      expect(chooseFiles).toHaveBeenCalled();
      expect(mockActions.createContext).toHaveBeenCalledTimes(2);
      expect(mockActions.createContext).toHaveBeenNthCalledWith(1, 'foo', '/abs/foo.md', { kind: 'reference' });
      expect(mockActions.createContext).toHaveBeenNthCalledWith(2, 'bar', '/abs/bar.json', { kind: 'reference' });
    } finally {
      delete (window as any).electron;
    }
  });

  it('handleWebFiles flow imports each file as embedded when web (no electron.chooseFiles)', async () => {
    render(<ContextsPopover anchorRect={anchorRect} anchorEl={null} onClose={() => {}} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    // Provide a File via the change event.
    const file = new File(['hello'], 'doc.md', { type: 'text/markdown' });
    // Stub the FileList on the input.
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) },
    });
    await act(async () => {
      fireEvent.change(input);
    });
    expect(mockImportWorkspaceFileUpload).toHaveBeenCalledWith(
      'p1',
      '/tmp/p1',
      file,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
    expect(mockActions.createContext).toHaveBeenCalledWith('doc', '.contexts/doc.md', { size: 5 });
  });
});
