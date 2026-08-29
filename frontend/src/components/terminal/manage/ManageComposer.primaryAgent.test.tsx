import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ManageComposer, { __resetManageComposerSessionStateForTests } from './ManageComposer';

const {
  createThread, sendMessage, bindPendingPrimaryAgent, listPrimaryAgentDefinitions,
} = vi.hoisted(() => ({
  createThread: vi.fn(async () => 'node-primary'),
  sendMessage: vi.fn(),
  bindPendingPrimaryAgent: vi.fn(),
  listPrimaryAgentDefinitions: vi.fn(),
}));

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: { id: 'ws-remote', name: 'Remote', backendConnectionId: 'remote-a', artifacts: [] },
    projects: [{ id: 'ws-remote', name: 'Remote', backendConnectionId: 'remote-a', artifacts: [] }],
    selectProject: vi.fn(), createThread, sendMessage,
    agentStatus: null, refreshAgentStatus: vi.fn(), availableModes: [{ id: 'build', name: 'Build' }],
  }),
}));

vi.mock('../../../services/api', () => ({
  bindPendingPrimaryAgent,
  listPrimaryAgentDefinitions,
  listAgentModels: vi.fn(async () => ({ models: [], sanitizedModel: null })),
  saveAgentOptions: vi.fn(async () => ({})),
  getWebUploadCwd: vi.fn(async () => '/tmp'),
  importWorkspaceFileUpload: vi.fn(),
}));

vi.mock('../../MentionEditor', () => ({
  default: React.forwardRef<any, any>(function MentionStub(props, ref) {
    React.useImperativeHandle(ref, () => ({ focus: () => {}, editor: null }));
    return <textarea value={props.value} onChange={(event) => props.onChange({ value: event.target.value, mentions: [] })} />;
  }),
}));

const implementer = {
  backendConnectionId: 'remote-a',
  definition: {
    version: 1, id: 'agent-implementer', ownerUserId: 'owner', scope: 'workspace', workspaceId: 'ws-remote',
    name: 'Implementer', description: 'Implements.', instructions: 'Implement.',
    runtimeProfile: { version: 1, runtimeId: 'pi', providerId: 'anthropic', modelId: 'sonnet' },
    fallbackChain: [], toolRefs: [], skillRefs: [], mcpServerRefs: [], permissionPolicy: null,
    contextPolicy: { version: 1, includeWorkspaceInstructions: true, allowMessageContext: true,
      allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 1000 },
    defaultRunTtlMs: null, status: 'enabled', revision: 3, createdAt: 1, updatedAt: 2,
  },
};

describe('ManageComposer primary Agent selection', () => {
  beforeEach(() => {
    __resetManageComposerSessionStateForTests();
    createThread.mockClear(); sendMessage.mockClear(); bindPendingPrimaryAgent.mockClear();
    listPrimaryAgentDefinitions.mockResolvedValue([implementer]);
  });
  it('fetches from the Workspace Backend and explicitly binds the selected Definition to the new thread', async () => {
    render(<ManageComposer workspaceId="ws-remote" enableAgentSelect onSubmitted={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(listPrimaryAgentDefinitions).toHaveBeenCalledWith('ws-remote', expect.any(AbortSignal));

    fireEvent.click(screen.getByTitle(/Switch agent/));
    fireEvent.click(await screen.findByText('Implementer'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    fireEvent.change(document.querySelector('textarea')!, { target: { value: 'Build it' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(createThread).toHaveBeenCalledWith(undefined));
    expect(bindPendingPrimaryAgent).toHaveBeenCalledWith('node-primary', {
      workspaceId: 'ws-remote', backendConnectionId: 'remote-a', definitionId: 'agent-implementer',
    });
    expect(sendMessage).toHaveBeenCalledWith('node-primary', 'Build it', undefined);
  });
});
