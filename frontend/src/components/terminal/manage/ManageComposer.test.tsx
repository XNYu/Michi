import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import ManageComposer, { __resetManageComposerSessionStateForTests } from './ManageComposer';

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
const sendMessage = vi.fn();
const selectProject = vi.fn();
const createContext = vi.fn();

// Mutable so individual tests can vary the agent list / status.
const storeState: Record<string, unknown> = {
  createThread,
  sendMessage,
  selectProject,
  createContext,
  agentStatus: null,
  refreshAgentStatus: vi.fn(),
  availableModes: [],
  projects: [],
};

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => storeState,
}));

vi.mock('../../../services/api', () => ({
  listAgentModels: vi.fn(async () => ({ models: [], sanitizedModel: null })),
  saveAgentOptions: vi.fn(async () => ({})),
  getWebUploadCwd: vi.fn(async () => '/tmp'),
  importWorkspaceFileUpload: vi.fn(),
}));

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
    sendMessage.mockClear();
    selectProject.mockClear();
    storeState.availableModes = [];
    storeState.agentStatus = null;
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
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
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

    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
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
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not submit empty input', () => {
    sendMessage.mockClear();
    const onSubmitted = vi.fn();
    render(
      <ManageComposer
        workspaceId="ws1"
        workspaceName="ws-one"
        onSubmitted={onSubmitted}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('hides the agent chip unless enableAgentSelect is set', () => {
    storeState.availableModes = [{ id: 'planner', name: 'Planner' }];
    render(
      <ManageComposer workspaceId="ws1" workspaceName="ws-one" onSubmitted={vi.fn()} />,
    );
    expect(screen.queryByTitle(/Switch agent/)).toBeNull();
  });

  it('pre-selected agent is stamped onto the new thread on send', () => {
    vi.useFakeTimers();
    storeState.availableModes = [
      { id: 'planner', name: 'Planner' },
      { id: 'build', name: 'Build' },
    ];
    render(
      <ManageComposer
        workspaceId="ws1"
        workspaceName="ws-one"
        enableAgentSelect
        onSubmitted={vi.fn()}
      />,
    );

    // Open the agent menu and pick "Build". The menu is a searchable
    // ContextMenu (a `filter…` input joins the composer textarea) and its pick
    // resolves after a confirm-blink timer.
    fireEvent.click(screen.getByTitle(/Switch agent/));
    fireEvent.click(screen.getByText('Build'));
    flushBlink();

    const ta = composerTextarea();
    fireEvent.change(ta, { target: { value: 'plan this' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(createThread).toHaveBeenCalledWith('build');
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
});
