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

function renderToolbar(overrides: Partial<ComponentProps<typeof PaneComposerToolbarLeft> & ComponentProps<typeof ComposerModelTrigger>> = {}) {
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
  return render(<><PaneComposerToolbarLeft {...props} /><ComposerModelTrigger {...props} /></>);
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
});
