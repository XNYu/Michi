import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ subscribeBackground: vi.fn() }));
vi.mock('../services/api', () => api);
import { createBackgroundTurnTransport } from './backgroundTurnTransport';
import { BACKEND_CONNECTION_READY } from '../config/backendConnectionState';

describe('remote event replay after connection recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); api.subscribeBackground.mockReset().mockReturnValue(vi.fn()); });
  afterEach(() => vi.useRealTimers());
  it('resumes with the retained cursor immediately on readiness and never overlaps a live feed', async () => {
    let seq = 8;
    const transport = createBackgroundTurnTransport({ connectionId: 'remote', handlersForChat: () => ({}),
      cursorSnapshot: () => ({ chat: { turnId: 'durable-turn', seq } }), random: () => 0.5 });
    transport.start();
    expect(api.subscribeBackground.mock.calls[0][1].cursors.chat.seq).toBe(8);
    seq = 12;
    api.subscribeBackground.mock.calls[0][1].onDisconnect({ retryable: true });
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId: 'other' } }));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId: 'remote' } }));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
    expect(api.subscribeBackground.mock.calls[1][1].cursors.chat).toEqual({ turnId: 'durable-turn', seq: 12 });
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
    transport.stop();
    window.dispatchEvent(new CustomEvent(BACKEND_CONNECTION_READY, { detail: { connectionId: 'remote' } }));
    expect(api.subscribeBackground).toHaveBeenCalledTimes(2);
  });
});
