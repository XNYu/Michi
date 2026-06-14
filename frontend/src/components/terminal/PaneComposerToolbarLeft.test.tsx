import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { AgentStatus } from '../../services/api';
import { PaneComposerToolbarLeft } from './PaneComposerToolbarLeft';

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

function renderToolbar(overrides: Partial<ComponentProps<typeof PaneComposerToolbarLeft>> = {}) {
  return render(
    <PaneComposerToolbarLeft
      canAttach
      toolbarTier={0}
      availableModesCount={0}
      agentStatus={STATUS}
      providerModels={[]}
      onPickFile={vi.fn()}
      onInsertMentionTrigger={vi.fn()}
      onOpenAgentMenu={vi.fn()}
      onOpenModelMenu={vi.fn()}
      {...overrides}
    />,
  );
}

describe('PaneComposerToolbarLeft', () => {
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
});
