import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchAssistant: vi.fn() }));
vi.mock('../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/assistant')>('../../services/api/assistant');
  return { ...actual, ...api };
});

import { AssistantApiError } from '../../services/api/assistant';
import {
  adoptAssistantInfo,
  ASSISTANT_PANEL_OPEN_KEY,
  getAssistantSnapshot,
  loadAssistant,
  openAssistantPanel,
  resetAssistantStoreForTests,
  toggleAssistantPanel,
} from './assistantStore';

const INFO = { nodeId: 'n1', workspaceId: 'w1', treeId: 't1', settings: { runtimeId: 'claude', modelId: null, reasoning: null }, supportedRuntimes: ['claude'] };

beforeEach(() => {
  api.fetchAssistant.mockReset();
  resetAssistantStoreForTests();
});
afterEach(() => resetAssistantStoreForTests());

describe('assistant store', () => {
  it('loads the assistant once', async () => {
    api.fetchAssistant.mockResolvedValue(INFO);
    await Promise.all([loadAssistant(), loadAssistant()]);
    await loadAssistant();
    expect(api.fetchAssistant).toHaveBeenCalledTimes(1);
    expect(getAssistantSnapshot()).toMatchObject({ status: 'ready', info: INFO });
  });

  it('turns itself off for good on a 404, and ⌘J then does nothing', async () => {
    api.fetchAssistant.mockRejectedValue(new AssistantApiError(404, 'Not found'));
    expect(toggleAssistantPanel()).toBe(true);
    await loadAssistant();
    expect(getAssistantSnapshot()).toMatchObject({ status: 'unsupported', open: false });
    expect(toggleAssistantPanel()).toBe(false);
    expect(openAssistantPanel()).toBe(false);
    expect(getAssistantSnapshot().open).toBe(false);
  });

  it('treats an answer that is not the assistant as no assistant', async () => {
    api.fetchAssistant.mockRejectedValueOnce(new AssistantApiError(200, 'Unexpected assistant response', true));
    await loadAssistant();
    expect(getAssistantSnapshot().status).toBe('unsupported');
    resetAssistantStoreForTests();
    api.fetchAssistant.mockResolvedValueOnce({});
    await loadAssistant();
    expect(getAssistantSnapshot().status).toBe('unsupported');
  });

  it('keeps other failures retryable', async () => {
    api.fetchAssistant.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(INFO);
    await loadAssistant();
    expect(getAssistantSnapshot()).toMatchObject({ status: 'error', error: 'Failed to fetch' });
    await loadAssistant();
    expect(getAssistantSnapshot().status).toBe('ready');
  });

  it('remembers the open state for this window', () => {
    toggleAssistantPanel();
    expect(window.sessionStorage.getItem(ASSISTANT_PANEL_OPEN_KEY)).toBe('1');
    toggleAssistantPanel();
    expect(window.sessionStorage.getItem(ASSISTANT_PANEL_OPEN_KEY)).toBeNull();
  });

  it('follows a reset to the new node, and ignores anything that is not the assistant', () => {
    adoptAssistantInfo({ ...INFO, nodeId: 'n2' });
    expect(getAssistantSnapshot()).toMatchObject({ status: 'ready', info: { nodeId: 'n2' } });
    adoptAssistantInfo({ nodeId: 'n3' });
    expect(getAssistantSnapshot().info?.nodeId).toBe('n2');
    resetAssistantStoreForTests({ status: 'unsupported' });
    adoptAssistantInfo(INFO);
    expect(getAssistantSnapshot().status).toBe('unsupported');
  });
});
