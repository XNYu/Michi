/**
 * The ⌘J assistant runs on its own settings (Settings → Assistant), which
 * the backend pins on every session path. Its composer never sends the
 * global runtime defaults of the user's chats, and its model chip shows
 * what the conversation runs on, not those defaults.
 */
import React from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const GLOBAL_STATUS = vi.hoisted(() => ({
  runtime: 'codex',
  label: 'Codex',
  capabilities: {
    modes: false, permissions: true, models: true, providerModels: true, reasoning: true,
    supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'], apiKeys: false,
    warmSessions: false, saveContext: false, spawnBranches: false,
  },
  availableRuntimes: [{ id: 'codex', label: 'Codex' }],
  provider: 'anthropic',
  model: 'gpt-6-astra',
  reasoning: 'xhigh',
  providerByRuntime: { codex: 'anthropic' },
  modelByRuntime: { codex: 'gpt-6-astra' },
  reasoningByRuntime: { codex: 'xhigh' },
  hasRequiredKey: true,
}));

vi.mock('../../services/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api')>()),
  allocateNodeIdsLocal: (() => { let i = 0; return (count = 1) => Array.from({ length: count }, () => `n-ab-${++i}`); })(),
  listAgentModes: () => Promise.resolve({ availableModes: [], defaultModeId: null }),
  fetchAgentStatus: () => Promise.resolve(GLOBAL_STATUS),
  listModels: () => Promise.resolve({ models: [], defaultModel: null }),
  fetchPrefs: () => Promise.resolve(null),
  savePrefs: () => Promise.resolve(),
  warmCwd: () => Promise.resolve({ ok: true }),
  subscribeChat: vi.fn(() => () => {}),
  subscribeChats: vi.fn(() => () => {}),
  subscribeBackground: vi.fn(() => () => {}),
  cancelChatAndObserve: vi.fn(() => () => {}),
  fetchAllWorkspacesMeta: vi.fn(async () => []),
  fetchTreeMessages: vi.fn(async () => []),
  listBackendConnections: async () => [],
  ensureSession: vi.fn(() => Promise.reject(new Error('offline in tests'))),
  streamMessage: vi.fn(() => () => {}),
}));
vi.mock('../../services/notifications', () => ({ notify: vi.fn() }));
vi.mock('../SelectionActions', () => ({ default: () => null }));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef((_props: unknown, _ref: unknown) => <textarea data-testid="composer" />),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

import TPane from './TPane';
import * as api from '../../services/api';
import { ChatProvider, useChatActions, useChatStore, useChatNodesSnapshot } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import { resetAssistantStoreForTests } from '../../state/assistant/assistantStore';

if (typeof CSS === 'undefined') (globalThis as { CSS?: unknown }).CSS = {};
if (!(CSS as unknown as { highlights?: unknown }).highlights) (CSS as unknown as { highlights: Map<string, unknown> }).highlights = new Map();
if (typeof Element.prototype.scrollTo !== 'function') Element.prototype.scrollTo = () => {};
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }),
});

const SYSTEM = {
  workspace: { id: 'sys', name: 'Michi assistant', created_at: 1, settings: JSON.stringify({ system: 'assistant' }) },
  trees: [{ id: 't-sys', root_node_id: 'n-sys', last_active_at: 1 }],
  nodes: [{ id: 'n-sys', created_at: 1 }],
  edges: [],
  messages: [],
};
const INFO = {
  nodeId: 'n-sys', workspaceId: 'sys', treeId: 't-sys',
  settings: { runtimeId: 'codex' as const, modelId: null, reasoning: null },
  conversation: { runtimeId: 'codex' as const, modelId: null, reasoning: null },
  supportedRuntimes: ['codex' as const],
};

let store: ReturnType<typeof useChatStore>;
let actions: ReturnType<typeof useChatActions>;
let nodes: ReturnType<typeof useChatNodesSnapshot>;
let shown: string | null = null;
function Harness() {
  store = useChatStore();
  actions = useChatActions();
  nodes = useChatNodesSnapshot();
  return shown ? <TPane nodeId={shown} embedded /> : null;
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline in tests'))));
});
afterAll(() => {
  vi.unstubAllGlobals();
  act(() => resetAssistantStoreForTests());
});

describe('TPane — the assistant runs on its own settings', () => {
  it('sends none of the global runtime defaults and shows the conversation\'s model', async () => {
    localStorage.clear();
    const view = render(<PrefsProvider><ChatProvider><Harness /></ChatProvider></PrefsProvider>);
    await waitFor(() => expect(store.hydrated).toBe(true));
    await waitFor(() => expect(store.agentStatus?.model).toBe('gpt-6-astra'));
    await act(async () => { await store.createProject('Work', '/work'); });
    act(() => { store.createThread(); });
    act(() => { actions.installWorkspaceSnapshot(SYSTEM); });
    await waitFor(() => expect(nodes['n-sys']).toBeTruthy());
    act(() => resetAssistantStoreForTests({ open: true, status: 'ready', info: INFO }));
    shown = 'n-sys';
    view.rerender(<PrefsProvider><ChatProvider><Harness /></ChatProvider></PrefsProvider>);

    // Nothing to set here, so it says what it is, not "Model settings".
    const chip = await screen.findByRole('button', { name: /^Model: / });
    expect(chip.textContent).not.toContain('gpt-6-astra');
    expect(chip.textContent).toContain('Default model');
    // Settings → Assistant owns these: the chip opens no picker.
    expect((chip as HTMLButtonElement).disabled).toBe(true);

    const ensure = vi.mocked(api.ensureSession);
    ensure.mockClear();
    act(() => store.setComposerDraft('n-sys', { value: 'What is waiting on me?', mentions: [] }));
    const send = await screen.findByRole('button', { name: 'Send (Enter)' });
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
    // Nothing of the composer's own: the backend pins the assistant settings.
    const request = ensure.mock.calls[0][0];
    expect(request.runtimeId ?? null).toBeNull();
    expect(request.providerId ?? null).toBeNull();
    expect(request.modelId ?? null).toBeNull();
    expect(request.reasoning ?? null).toBeNull();
    shown = null;
  });
});
