import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { AgentStatus } from '../../services/api';
import { PaneComposerToolbarLeft } from './PaneComposerToolbarLeft';
import { ComposerModelTrigger } from './ComposerModelTrigger';

const STATUS: AgentStatus = {
  runtime: 'kiro',
  label: 'Kiro',
  capabilities: {
    modes: true,
    permissions: true,
    models: true,
    providerModels: false,
    reasoning: false,
    supportedReasoningLevels: [],
    apiKeys: false,
    warmSessions: true,
    saveContext: true,
    spawnBranches: true,
    nativeResume: true,
  },
  availableRuntimes: [],
  model: 'claude-sonnet',
  hasRequiredKey: true,
};

function renderToolbar(overrides: Partial<ComponentProps<typeof PaneComposerToolbarLeft> & ComponentProps<typeof ComposerModelTrigger>> = {}, within?: HTMLElement) {
  const props = {
    canAttach: true,
    toolbarTier: 0 as const,
    availableModesCount: 0,
    agentStatus: STATUS,
    resolvedBinding: { runtime: 'kiro', provider: undefined, model: 'claude-sonnet', reasoning: undefined, source: 'global' as const },
    catalogCapabilities: null,
    providerModels: [],
    isStreaming: false,
    onPickFile: vi.fn(),
    onInsertMentionTrigger: vi.fn(),
    onOpenAgentMenu: vi.fn(),
    onOpenModelMenu: vi.fn(),
    ...overrides,
  };
  const ui = <><PaneComposerToolbarLeft {...props} /><ComposerModelTrigger {...props} /></>;
  return render(ui, within ? { container: within.appendChild(document.createElement('div')) } : undefined);
}

describe('ComposerModelTrigger switch hint', () => {
  test('says what a model switch also stops, in its label and tooltip', () => {
    const hint = 'Switching the model also stops the running workflow.';
    renderToolbar({ switchHint: hint });
    const trigger = screen.getByRole('button', { name: /^Model settings: .*\. Switching the model also stops the running workflow\.$/ });
    expect(trigger.title.endsWith(`. ${hint}`)).toBe(true);
    cleanup();
    renderToolbar();
    expect(screen.getByRole('button', { name: /^Model settings: / }).title).not.toContain(hint);
  });
});

describe('PaneComposerToolbarLeft', () => {
  test('offers attach and mention, and leaves both out where they do nothing (the assistant)', () => {
    const view = renderToolbar();
    expect(screen.getByTitle('Attach file')).toBeTruthy();
    expect(screen.getByTitle('Mention context or node')).toBeTruthy();
    view.unmount();
    renderToolbar({ contextTools: false });
    expect(screen.queryByTitle('Attach file')).toBeNull();
    expect(screen.queryByTitle(/Open a workspace to attach/)).toBeNull();
    expect(screen.queryByTitle('Mention context or node')).toBeNull();
  });

  test('keeps model settings reachable in the narrowest toolbar', () => {
    const onOpenModelMenu = vi.fn();
    renderToolbar({ toolbarTier: 2, onOpenModelMenu });
    const trigger = screen.getByRole('button', { name: /Model settings/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(onOpenModelMenu).toHaveBeenCalledWith(expect.objectContaining({ trigger, keyboard: true }));
  });

  test('opens the agent and model menus downward on Home, whose composer sits at the top', () => {
    const onOpenAgentMenu = vi.fn();
    const onOpenModelMenu = vi.fn();
    const props = { onOpenAgentMenu, onOpenModelMenu, availableModesCount: 2, currentModeId: 'dev' };
    const openBoth = () => {
      fireEvent.click(screen.getByTitle(/^Switch agent/));
      fireEvent.click(screen.getByRole('button', { name: /Model settings/ }));
    };
    renderToolbar(props);
    openBoth();
    expect(onOpenAgentMenu).toHaveBeenLastCalledWith(expect.objectContaining({ preferBelow: false }));
    expect(onOpenModelMenu).toHaveBeenLastCalledWith(expect.objectContaining({ preferBelow: false }));
    cleanup();

    const home = document.body.appendChild(document.createElement('div'));
    home.className = 'home-compose';
    renderToolbar(props, home);
    openBoth();
    expect(onOpenAgentMenu).toHaveBeenLastCalledWith(expect.objectContaining({ preferBelow: true }));
    expect(onOpenModelMenu).toHaveBeenLastCalledWith(expect.objectContaining({ preferBelow: true }));
    cleanup();
    home.remove();
  });
});
