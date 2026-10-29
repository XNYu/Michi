import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { METACHAT_STORAGE_KEY } from '../../../state/metaChat/metaChatWindowModel';
import { AssistantApiError, metaAgentTurnContextFor, type AssistantInfo } from '../../../services/api/assistant';
import { isShownInAssistantPanel, resetAssistantStoreForTests } from '../../../state/assistant/assistantStore';
import {
  getScheduleAssistantSnapshot,
  resetScheduleAssistantStoreForTests,
  revealScheduleAssistant,
} from '../../../state/assistant/scheduleAssistantStore';
import { CREATE_WITH_AGENT_LABEL, SCHEDULED_AGENT_WINDOW_KEY, ScheduledAgentChat } from './ScheduledAgentChat';

const api = vi.hoisted(() => ({ fetch: vi.fn(), reset: vi.fn() }));
vi.mock('../../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../../services/api/assistant')>('../../../services/api/assistant');
  return { ...actual, fetchScheduleAssistant: api.fetch, resetScheduleAssistant: api.reset };
});
vi.mock('../../../state/assistant/useAssistantNode', () => ({ useAssistantNode: () => ({ state: 'ready', retry: () => {} }) }));
vi.mock('../assistant/AssistantLinks', () => ({
  AssistantLinkScope: ({ children }: { children: ReactNode }) => children,
  AssistantLinkChip: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('../../../state/chatStore', () => ({
  useChatProjects: () => ({ projects: [{ id: 'ws-1', name: 'michi', chatIds: [] }], agentStatus: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));
vi.mock('../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: null, error: null, unreachable: false, schedulerOff: false, justFinished: false }),
}));
/** Stands in for the conversation: which node it shows and which window's info its composer follows. */
vi.mock('../TPane', () => ({
  default: ({ nodeId, assistantSource }: { nodeId: string; assistantSource?: { info: AssistantInfo | null } }) => (
    <div data-testid="tpane" data-node={nodeId} data-source={assistantSource?.info?.nodeId ?? ''} />
  ),
}));

const info = (nodeId = 'n-s1'): AssistantInfo => ({
  nodeId, workspaceId: 'p-assistant', treeId: `t-${nodeId}`, supportedRuntimes: ['claude'],
  settings: { runtimeId: 'claude', modelId: null, reasoning: null },
  conversation: { runtimeId: 'claude', modelId: null, reasoning: null },
});

function chat(props: { enabled?: boolean; defaultWorkspaceId?: string | null } = {}) {
  return (
    <ScheduledAgentChat enabled={props.enabled ?? true} defaultWorkspaceId={props.defaultWorkspaceId === undefined ? 'ws-1' : props.defaultWorkspaceId}>
      <div data-testid="page">jobs</div>
    </ScheduledAgentChat>
  );
}

const area = () => document.querySelector('.meta-chat-area') as HTMLElement;
const launcher = () => screen.findByRole('button', { name: CREATE_WITH_AGENT_LABEL });

beforeEach(() => {
  api.fetch.mockReset().mockResolvedValue(info());
  api.reset.mockReset();
  resetScheduleAssistantStoreForTests();
  resetAssistantStoreForTests();
  localStorage.clear();
  // The page area measures 1000×800, so the floating window has a box.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = this.classList.contains('meta-chat-area') ? { left: 0, top: 0, width: 1000, height: 800 } : { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('ScheduledAgentChat', () => {
  it('starts as a labelled button over the page, and offers nothing where the page cannot schedule', async () => {
    const view = render(chat({ enabled: false }));
    expect(screen.getByTestId('page')).toBeTruthy();
    expect(screen.queryByRole('button', { name: CREATE_WITH_AGENT_LABEL })).toBeNull();
    expect(api.fetch).not.toHaveBeenCalled();

    view.rerender(chat());
    const button = await launcher();
    expect(button.textContent).toBe(CREATE_WITH_AGENT_LABEL);
    expect(area().dataset.form).toBe('min');
    await waitFor(() => expect(getScheduleAssistantSnapshot().status).toBe('ready'));
    expect(api.fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('tpane')).toBeNull();
  });

  it('shows no button on a backend without the conversation', async () => {
    api.fetch.mockRejectedValue(new AssistantApiError(404, 'Not found'));
    render(chat());
    await waitFor(() => expect(getScheduleAssistantSnapshot().status).toBe('unsupported'));
    expect(screen.queryByRole('button', { name: CREATE_WITH_AGENT_LABEL })).toBeNull();
    expect(screen.getByTestId('page')).toBeTruthy();
  });

  it('opens its own conversation, telling the agent the workspace New job preselects', async () => {
    const view = render(chat());
    fireEvent.click(await launcher());
    const pane = await screen.findByTestId('tpane');
    expect(pane.dataset.node).toBe('n-s1');
    expect(pane.dataset.source, 'the composer follows this window, not the Spaces assistant').toBe('n-s1');
    expect(metaAgentTurnContextFor('n-s1')).toEqual({ schedule: { workspaceId: 'ws-1' } });
    view.rerender(chat({ defaultWorkspaceId: 'ws-2' }));
    expect(metaAgentTurnContextFor('n-s1')).toEqual({ schedule: { workspaceId: 'ws-2' } });
    view.rerender(chat({ defaultWorkspaceId: null }));
    expect(metaAgentTurnContextFor('n-s1')).toEqual({ schedule: { workspaceId: null } });

    expect(isShownInAssistantPanel('n-s1')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(isShownInAssistantPanel('n-s1')).toBe(false);
    expect(screen.getByTestId('tpane'), 'the conversation stays mounted for its draft').toBeTruthy();
    expect(localStorage.getItem(SCHEDULED_AGENT_WINDOW_KEY)).not.toBeNull();
    expect(localStorage.getItem(METACHAT_STORAGE_KEY), 'the Spaces window keeps its own place').toBeNull();
  });

  it('New conversation starts only this window over', async () => {
    api.reset.mockResolvedValue(info('n-s2'));
    render(chat());
    fireEvent.click(await launcher());
    await screen.findByTestId('tpane');
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(screen.getByTestId('tpane').dataset.node).toBe('n-s2'));
    expect(api.reset).toHaveBeenCalledWith('n-s1');
    expect(metaAgentTurnContextFor('n-s2')).toEqual({ schedule: { workspaceId: 'ws-1' } });
  });

  it('another window having started over shows the conversation that is current now', async () => {
    api.reset.mockRejectedValue(new AssistantApiError(409, 'The assistant already started over', false, info('n-s3')));
    render(chat());
    fireEvent.click(await launcher());
    await screen.findByTestId('tpane');
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    await waitFor(() => expect(screen.getByTestId('tpane').dataset.node).toBe('n-s3'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens full screen on a phone-sized window', async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
    try {
      render(chat());
      fireEvent.click(await launcher());
      expect(area().dataset.form).toBe('full');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('a notification or the asking bar for this conversation opens the window on the Scheduled page', async () => {
    const nav = vi.fn();
    window.addEventListener('michi:nav-page', nav);
    try {
      render(chat());
      await waitFor(() => expect(getScheduleAssistantSnapshot().status).toBe('ready'));
      expect(revealScheduleAssistant('n-other')).toBe(false);
      expect(nav).not.toHaveBeenCalled();
      act(() => { expect(revealScheduleAssistant('n-s1')).toBe(true); });
      expect((nav.mock.calls[0][0] as CustomEvent).detail).toEqual({ page: 'scheduled' });
      expect(area().dataset.form).toBe('float');
    } finally {
      window.removeEventListener('michi:nav-page', nav);
    }
  });
});
