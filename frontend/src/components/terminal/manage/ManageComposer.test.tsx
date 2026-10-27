vi.mock('../../../state/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../../state/prefs')>('../../../state/prefs');
  return { ...actual, usePrefs: () => ({ prefs: actual.DEFAULT_PREFS }) };
});
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import ManageComposer, { __resetManageComposerSessionStateForTests } from './ManageComposer';
import { fetchRuntimeCatalog, importWorkspaceFileUpload, saveAgentOptions } from '../../../services/api';
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
  fetchRuntimeCatalog: vi.fn(async () => ({ models: [], providers: [], capabilities: null })),
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

  it('shows the runtime default when the remembered agent is not in the current catalog', async () => {
    storeState.agentStatus = { runtime: 'kiro', capabilities: { modes: true } };
    storeState.availableModes = [{ id: 'planner', name: 'Planner' }, { id: 'build', name: 'Build' }];
    storeState.defaultModeId = 'build';
    const first = render(<ManageComposer workspaceId="ws1" enableAgentSelect onSubmitted={vi.fn()} />);
    await screen.findByRole('textbox');
    fireEvent.click(screen.getByTitle(/Switch agent/));
    fireEvent.click(screen.getByText('Planner'));
    await screen.findByTitle('Switch agent — Planner');
    first.unmount();

    // e.g. a workspace-level agent that this workspace does not define.
    storeState.availableModes = [{ id: 'build', name: 'Build' }];
    const second = render(<ManageComposer workspaceId="ws1" enableAgentSelect onSubmitted={vi.fn()} />);
    expect(screen.getByTitle('Switch agent — Build')).toBeTruthy();
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(createThread).toHaveBeenLastCalledWith(undefined);
    second.unmount();

    // The pick is kept for catalogs that do contain it.
    storeState.availableModes = [{ id: 'planner', name: 'Planner' }, { id: 'build', name: 'Build' }];
    render(<ManageComposer workspaceId="ws1" enableAgentSelect onSubmitted={vi.fn()} />);
    expect(screen.getByTitle('Switch agent — Planner')).toBeTruthy();
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

// The Home picker edits the backend's global defaults. Each save names the
// runtime the picker shows, so a save made against stale status is rejected
// instead of storing one runtime's model under another.
describe('ManageComposer Home model defaults', () => {
  const capabilities = {
    modes: false, permissions: false, models: true, providerModels: false, reasoning: true,
    supportedReasoningLevels: ['low', 'medium', 'high'], apiKeys: false, warmSessions: true, saveContext: false, spawnBranches: false,
  };
  const levels = ['low', 'medium', 'high'] as const;
  const models = [
    { id: 'opus-5.5', label: 'Opus 5.5', supportedReasoningLevels: [...levels] },
    { id: 'sonnet-5.5', label: 'Sonnet 5.5', supportedReasoningLevels: [...levels] },
  ];

  beforeEach(() => {
    __resetManageComposerSessionStateForTests();
    // Reduced motion confirms menu picks without the blink delay.
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    storeState.availableModes = [];
    storeState.projects = [{ id: 'ws1', name: 'Workspace', cwd: '/tmp', artifacts: [] }];
    storeState.agentStatus = {
      runtime: 'kiro', label: 'Kiro', model: 'opus-5.5', reasoning: 'medium', hasRequiredKey: true, capabilities,
      availableRuntimes: [{ id: 'kiro', label: 'Kiro', available: true }, { id: 'claude', label: 'Claude', available: true }],
    };
    vi.mocked(fetchRuntimeCatalog).mockResolvedValue({ models, providers: [], capabilities } as never);
    vi.mocked(saveAgentOptions).mockReset().mockResolvedValue({ ok: true });
    vi.mocked(storeState.refreshAgentStatus as () => void).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(fetchRuntimeCatalog).mockResolvedValue({ models: [], providers: [], capabilities: null } as never);
  });

  async function pickModel(name: string) {
    render(<ManageComposer workspaceId="ws1" workspaceName="ws-one" onSubmitted={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Model settings:/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Select model:/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name }));
  }

  it('saves model and effort for the runtime the picker shows', async () => {
    await pickModel('Sonnet 5.5');
    await waitFor(() => expect(saveAgentOptions).toHaveBeenCalledExactlyOnceWith({ model: 'sonnet-5.5', expectedRuntime: 'kiro' }));
    const effort = await screen.findByRole('slider', { name: 'Thinking effort' });
    fireEvent.change(effort, { target: { value: '2' } });
    await waitFor(() => expect(saveAgentOptions).toHaveBeenLastCalledWith({ reasoning: 'high', expectedRuntime: 'kiro' }));
    expect(storeState.refreshAgentStatus).toHaveBeenCalledTimes(2);
  });

  it('reloads status and shows why when the backend has switched runtime', async () => {
    vi.mocked(saveAgentOptions).mockResolvedValue({ ok: false, error: 'The active runtime is now Claude. Check the selection and try again.' });
    await pickModel('Sonnet 5.5');
    expect((await screen.findByRole('alert')).textContent).toContain('The active runtime is now Claude');
    expect(storeState.refreshAgentStatus).toHaveBeenCalledOnce();
  });
});
