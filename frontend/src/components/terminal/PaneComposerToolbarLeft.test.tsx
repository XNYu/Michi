import { fireEvent, render, screen } from '@testing-library/react';
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

describe('PaneComposerToolbarLeft', () => {
  test('hides stale effort labels for models with no adjustable effort', () => {
    renderToolbar({
      agentStatus: { ...STATUS, capabilities: { ...STATUS.capabilities, reasoning: true, supportedReasoningLevels: ['low', 'high'] } },
      resolvedBinding: { runtime: 'kiro', provider: undefined, model: 'fixed', reasoning: 'high', source: 'pending' },
      providerModels: [{ id: 'fixed', label: 'Fixed model', supportedReasoningLevels: ['high'] }],
    });
    expect(screen.getByRole('button', { name: 'Model settings: kiro, Fixed model' })).toBeTruthy();
    expect(screen.queryByText('High')).toBeNull();
  });

  test('can render model settings after the left-side agent controls', () => {
    renderToolbar({
      currentMode: { id: 'agent', name: 'Agent' },
      agentStatus: {
        ...STATUS,
        availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }],
      },
    });

    const runtimeChip = screen.getByRole('button', { name: /^Model settings: Kiro/ });
    const agentChip = screen.getByTitle('Switch agent — Agent');
    expect(agentChip.compareDocumentPosition(runtimeChip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('shows Codex default effort in the composer', () => {
    renderToolbar({
      agentStatus: {
        ...STATUS,
        runtime: 'codex',
        label: 'Codex',
        capabilities: {
          ...STATUS.capabilities,
          reasoning: true,
          supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        },
        reasoning: 'xhigh',
      },
      resolvedBinding: {
        runtime: 'codex',
        provider: undefined,
        model: 'gpt-5-codex',
        reasoning: 'xhigh',
        source: 'global',
      },
    });

    expect(screen.getByRole('button', { name: /Extra high effort/ })).toBeTruthy();
    expect(screen.getByText('Extra high')).toBeTruthy();
  });

  test('shows the agent chip while the modes list is still loading', () => {
    renderToolbar();

    expect(screen.getByTitle(/Switch agent/)).toBeTruthy();
    expect(screen.getByText('agent')).toBeTruthy();
    expect(screen.getByText('claude-sonnet')).toBeTruthy();
  });

  test('can hide the agent chip for composers without a session target', () => {
    renderToolbar({ enableAgentChip: false });

    expect(screen.queryByTitle(/Switch agent/)).toBeNull();
    expect(screen.getByText('claude-sonnet')).toBeTruthy();
  });

  test('does not expose internal capability descriptors in the composer', () => {
    renderToolbar({
      agentStatus: {
        ...STATUS,
        capabilityDescriptor: {
          steer: { availability: 'native', confidence: 'native' },
          followUp: { availability: 'invisible', confidence: 'unverifiable' },
          interruptAck: { availability: 'native', confidence: 'native' },
          compact: { availability: 'native', confidence: 'native' },
          retry: { availability: 'invisible', confidence: 'unverifiable' },
          sessionFork: { availability: 'native_unwired', confidence: 'unknown' },
          nativeResume: { availability: 'native', confidence: 'native' },
          permissions: { availability: 'native', confidence: 'native' },
          sandbox: { availability: 'native', confidence: 'native' },
          subagents: { availability: 'invisible', confidence: 'unverifiable' },
          usage: { availability: 'native', confidence: 'native' },
        },
      },
    });

    expect(screen.queryByText('steer:native')).toBeNull();
    expect(screen.queryByText('usage:native')).toBeNull();
  });

  test('keeps model settings reachable in the narrowest toolbar', () => {
    const onOpenModelMenu = vi.fn();
    renderToolbar({ toolbarTier: 2, onOpenModelMenu });
    const trigger = screen.getByRole('button', { name: /Model settings/ });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(onOpenModelMenu).toHaveBeenCalledWith(expect.objectContaining({ trigger, keyboard: true }));
  });

  test('disables the native trigger while streaming', () => {
    const onOpenModelMenu = vi.fn();
    renderToolbar({ isStreaming: true, onOpenModelMenu });
    const trigger = screen.getByRole('button', { name: /Model settings/ });
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(trigger);
    expect(onOpenModelMenu).not.toHaveBeenCalled();
  });

  test('exposes the expanded state and does not invent global-runtime capabilities', () => {
    renderToolbar({ modelMenuOpen: true, resolvedBinding: { runtime: 'other', model: undefined, provider: undefined, reasoning: 'high', source: 'pending' } });
    const trigger = screen.getByRole('button', { name: /Model settings/ });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.textContent).toBe('other');
  });
});
