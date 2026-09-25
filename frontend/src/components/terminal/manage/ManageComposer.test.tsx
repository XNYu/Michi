import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import ManageComposer, { __resetManageComposerSessionStateForTests } from './ManageComposer';
import { importWorkspaceFileUpload } from '../../../services/api';
import { toast } from 'sonner';

// The agent switcher menu is a searchable ContextMenu: it renders a `filter…`
// <input> (a second textbox) and fires its `run` after a ~160ms confirm blink.
// So the composer textarea must be queried specifically, and menu picks must
// be flushed past the blink timer.
const composerTextarea = () =>
  document.querySelector('textarea') as HTMLTextAreaElement;
afterEach(() => {
  vi.useRealTimers();
});
function flushBlink() {
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

const createThread = vi.fn(async () => 'new-node-id');
const createChildChat = vi.fn(async (..._args: unknown[]) => 'child-node-id');
const sendMessage = vi.fn();
const selectProject = vi.fn();
const createContext = vi.fn();

// Mutable so individual tests can vary the agent list / status.
const storeState: Record<string, unknown> = {
  createThread,
  createChildChat,
  sendMessage,
  selectProject,
  createContext,
  agentStatus: null,
  refreshAgentStatus: vi.fn(),
  availableModes: [],
  defaultModeId: null,
  projects: [],
};

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => storeState,
  // These tests exercise send/agent plumbing, not the @-mention candidate
  // list, and their Project fixtures omit `trees`; return an empty list.
  useStructuralSelector: () => [],
  shallowArrayEqual: Object.is,
  chatLabel: () => 'New thread',
}));

vi.mock('../../../services/api', () => ({
  listPrimaryAgentDefinitions: vi.fn(async () => []),
  bindPendingPrimaryAgent: vi.fn(),
  listAgentModels: vi.fn(async () => ({ models: [], sanitizedModel: null })),
  saveAgentOptions: vi.fn(async () => ({})),
  getWebUploadCwd: vi.fn(async () => '/tmp'),
  importWorkspaceFileUpload: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// Replace MentionEditor with a plain textarea so we can drive it via fireEvent.
vi.mock('../../MentionEditor', () => ({
  default: React.forwardRef<any, any>(function MentionStub(props, ref) {
    const { value, onChange } = props;
    React.useImperativeHandle(ref, () => ({ focus: () => {}, editor: null }));
    return (
      <textarea
        value={value}
        onChange={(e) => onChange({ value: e.target.value, mentions: [] })}
      />
    );
  }),
}));

describe('ManageComposer', () => {
  beforeEach(() => {
    __resetManageComposerSessionStateForTests();
    createThread.mockClear();
    createChildChat.mockReset().mockResolvedValue('child-node-id');
    sendMessage.mockClear();
    selectProject.mockClear();
    storeState.availableModes = [];
    storeState.defaultModeId = null;
    storeState.agentStatus = null;
    storeState.projects = [{ id: 'ws1', name: 'Workspace', cwd: '/tmp', artifacts: [] }];
    vi.mocked(toast.error).mockClear();
    vi.mocked(importWorkspaceFileUpload).mockReset().mockResolvedValue({
      name: 'notes', filePath: '.attachments/notes.txt', displayName: 'notes.txt', size: 5,
    });
  });

  it('submit triggers selectProject + createThread + sendMessage + onSubmitted', async () => {
    selectProject.mockClear();
    createThread.mockClear();
    sendMessage.mockClear();
    const onSubmitted = vi.fn();
    render(
      <ManageComposer
        workspaceId="ws1"
        workspaceName="ws-one"
        onSubmitted={onSubmitted}
      />,
    );
    const ta = await screen.findByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'hello there' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => {
      expect(selectProject).toHaveBeenCalledWith('ws1');
      expect(createThread).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith('new-node-id', 'hello there', undefined);
      expect(onSubmitted).toHaveBeenCalled();
    });
  });

  it('clears the remembered draft before submission navigation unmounts it', async () => {
    let unmountFirst = () => {};
    const onSubmitted = vi.fn(() => unmountFirst());
    const first = render(
      <ManageComposer
        workspaceId="ws1"
        workspaceName="ws-one"
        onSubmitted={onSubmitted}
      />,
    );
    unmountFirst = first.unmount;

    const ta = await screen.findByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'do not haunt home' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());

    render(
      <ManageComposer
        workspaceId="ws1"
        workspaceName="ws-one"
        onSubmitted={vi.fn()}
      />,
    );
    expect((await screen.findByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('hides the agent chip unless enableAgentSelect is set', () => {
    storeState.availableModes = [{ id: 'planner', name: 'Planner' }];
    render(
      <ManageComposer workspaceId="ws1" workspaceName="ws-one" onSubmitted={vi.fn()} />,
    );
    expect(screen.queryByTitle(/Switch agent/)).toBeNull();
  });

  it('remembers the pre-picked agent across remounts (sticky)', () => {
    vi.useFakeTimers();
    storeState.availableModes = [
      { id: 'planner', name: 'Planner' },
      { id: 'build', name: 'Build' },
    ];

    // First mount: pick Planner, then unmount.
    const first = render(
      <ManageComposer workspaceId="ws1" workspaceName="ws-one" enableAgentSelect onSubmitted={vi.fn()} />,
    );
    fireEvent.click(screen.getByTitle(/Switch agent/));
    fireEvent.click(screen.getByText('Planner'));
    flushBlink();
    first.unmount();

    // Second mount: the pick is restored without re-selecting.
    render(
      <ManageComposer workspaceId="ws1" workspaceName="ws-one" enableAgentSelect onSubmitted={vi.fn()} />,
    );
    expect(screen.getByTitle('Switch agent — Planner')).toBeTruthy();

    const ta = composerTextarea();
    fireEvent.change(ta, { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(createThread).toHaveBeenCalledWith('planner');
  });

  it('submits a digest follow-up with the selected mode, without creating a root thread', async () => {
    storeState.availableModes = [{ id: 'build', name: 'Build' }];
    const onSubmitted = vi.fn();
    render(<ManageComposer workspaceId="ws1" parentNodeId="digest-1" enableAgentSelect onSubmitted={onSubmitted} />);
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByTitle(/Switch agent/));
    fireEvent.click(screen.getByText('Build'));
    await waitFor(() => expect(screen.getByTitle('Switch agent — Build')).toBeTruthy());
    fireEvent.change(composerTextarea(), { target: { value: 'Follow up\non the decisions' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(createChildChat).toHaveBeenCalledWith('digest-1', 'Follow up\non the decisions', undefined, {
      modeId: 'build', primaryAgent: undefined,
    });
    expect(createThread).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(composerTextarea().value).toBe('');
  });

  it('sends the visible runtime, model and reasoning with a digest follow-up', async () => {
    storeState.agentStatus = {
      runtime: 'codex', model: 'test-model', reasoning: 'high',
      capabilities: { models: true, reasoning: true, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
    };
    render(<ManageComposer workspaceId="ws1" parentNodeId="digest-1" enableAgentSelect onSubmitted={vi.fn()} />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Explain this' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(createChildChat).toHaveBeenCalledWith(
      'digest-1', 'Explain this', expect.objectContaining({
        runtimeId: 'codex', modelId: 'test-model', reasoning: 'high', displayText: 'Explain this',
      }), expect.any(Object),
    ));
  });

  it('keeps Home and individual digest drafts isolated across navigation', async () => {
    const view = render(<ManageComposer workspaceId="ws1" onSubmitted={vi.fn()} />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Home draft' } });

    view.rerender(<ManageComposer workspaceId="ws1" parentNodeId="digest-1" onSubmitted={vi.fn()} />);
    expect(composerTextarea().value).toBe('');
    fireEvent.change(composerTextarea(), { target: { value: 'Digest one draft' } });

    view.rerender(<ManageComposer workspaceId="ws1" parentNodeId="digest-2" onSubmitted={vi.fn()} />);
    expect(composerTextarea().value).toBe('');
    fireEvent.change(composerTextarea(), { target: { value: 'Digest two draft' } });

    view.rerender(<ManageComposer workspaceId="ws1" parentNodeId="digest-1" onSubmitted={vi.fn()} />);
    expect(composerTextarea().value).toBe('Digest one draft');
    view.rerender(<ManageComposer workspaceId="ws2" parentNodeId="digest-1" onSubmitted={vi.fn()} />);
    expect(composerTextarea().value).toBe('');
    view.rerender(<ManageComposer workspaceId="ws1" parentNodeId="digest-1" onSubmitted={vi.fn()} />);
    expect(composerTextarea().value).toBe('Digest one draft');
    view.rerender(<ManageComposer workspaceId="ws1" onSubmitted={vi.fn()} />);
    expect(composerTextarea().value).toBe('Home draft');
  });

  it('prevents duplicate sends, retains a failed draft and allows retry', async () => {
    let rejectSend!: (error: Error) => void;
    createChildChat.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const onSubmitted = vi.fn();
    render(<ManageComposer workspaceId="ws1" parentNodeId="digest-1" onSubmitted={onSubmitted} />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Keep this draft' } });
    const send = screen.getByRole('button', { name: /send/i });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(createChildChat).toHaveBeenCalledOnce();

    await act(async () => rejectSend(new Error('Allocation failed')));
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(composerTextarea().value).toBe('Keep this draft');
    expect(toast.error).toHaveBeenCalledWith('Could not start digest follow-up', { description: 'Allocation failed' });
    fireEvent.click(send);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledOnce());
    expect(createChildChat).toHaveBeenCalledTimes(2);
  });

  it('uploads and sends attachment-only follow-ups and removes the file picker on unmount', async () => {
    const view = render(<ManageComposer workspaceId="ws1" parentNodeId="digest-1" onSubmitted={vi.fn()} />);
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByTitle('Attach file'));
    const picker = document.querySelector('input[type="file"]')!;
    fireEvent.change(picker, { target: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] } });
    await screen.findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(createChildChat).toHaveBeenCalledWith(
      'digest-1', expect.stringContaining('[Attached files:'), expect.objectContaining({
        displayText: '', attachments: [{ name: 'notes.txt', absPath: '/tmp/.attachments/notes.txt', relPath: '.attachments/notes.txt' }],
      }), expect.any(Object),
    ));
    view.unmount();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
