import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ITerminalOptions } from '@xterm/xterm';
import type { TerminalPalette } from '../../state/prefs';
import TerminalPane from './TerminalPane';
import { PALETTES } from './tokens';

const state = vi.hoisted(() => ({
  prefs: { terminalPalette: 'bone' as TerminalPalette, terminalAccentOverrides: {} },
  instances: [] as { options: ITerminalOptions; dispose: ReturnType<typeof vi.fn> }[],
  create: vi.fn(async () => ({ data: '' })),
}));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: state.prefs }) }));
vi.mock('../../state/chatStore', () => ({
  useChatActions: () => ({ focusPane: vi.fn(), setFocusedNodeId: vi.fn() }),
}));
vi.mock('../../hooks/usePaneShellStyle', () => ({ usePaneShellStyle: () => ({}) }));
vi.mock('../../lib/electronBridge', () => ({ getElectron: () => ({
  terminalCreate: state.create, terminalWrite: vi.fn(), terminalResize: vi.fn(),
}) }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options: ITerminalOptions;
  dispose = vi.fn();
  constructor(options: ITerminalOptions) { this.options = options; state.instances.push(this); }
  loadAddon() {}
  open() {}
  onData() { return { dispose: vi.fn() }; }
  write() {}
  focus() {}
} }));
const item = {
  id: 'terminal-1', kind: 'terminal' as const, projectId: 'project-1', treeId: 'tree-1',
  createdAt: 1, surfaceId: 'surface-1', cwd: '/tmp', title: 'Terminal',
};

afterEach(() => { vi.unstubAllGlobals(); state.instances.length = 0; state.create.mockClear(); });

describe('TerminalPane theme updates', () => {
  it('updates all four palettes and accent without reconnecting or disposing the terminal', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    state.prefs = { terminalPalette: 'bone', terminalAccentOverrides: {} };
    const view = render(<TerminalPane item={item} />);
    await act(async () => {});
    const terminal = state.instances[0];
    expect(terminal.options.minimumContrastRatio).toBe(4.5);
    for (const palette of ['bone', 'slate', 'monokai', 'gruvbox'] as const) {
      state.prefs = { terminalPalette: palette, terminalAccentOverrides: {} };
      view.rerender(<TerminalPane item={item} />);
      expect(terminal.options.theme).toMatchObject({
        background: PALETTES[palette].surface, foreground: PALETTES[palette].fg,
        selectionForeground: PALETTES[palette].fg, selectionBackground: PALETTES[palette].selectF,
      });
      for (const key of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const) {
        expect(terminal.options.theme?.[key]).toMatch(/^#[0-9a-f]{6}$/);
        const bright = `bright${key[0].toUpperCase()}${key.slice(1)}`;
        expect(terminal.options.theme).toHaveProperty(bright, expect.stringMatching(/^#[0-9a-f]{6}$/));
      }
    }
    state.prefs = { terminalPalette: 'gruvbox', terminalAccentOverrides: { gruvbox: '#abcdef' } };
    view.rerender(<TerminalPane item={item} />);
    expect(terminal.options.theme?.cursor).toBe('#abcdef');
    expect(state.instances).toHaveLength(1);
    expect(state.create).toHaveBeenCalledOnce();
    expect(terminal.dispose).not.toHaveBeenCalled();
    view.unmount();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });
});
