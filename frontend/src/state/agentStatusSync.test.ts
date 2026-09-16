import { afterEach, describe, expect, it, vi } from 'vitest';
import { broadcastAgentStatusChanged, subscribeAgentStatusChanged } from './agentStatusSync';

class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;

  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.push(this);
  }

  postMessage(data: unknown): void {
    for (const channel of FakeBroadcastChannel.channels) {
      if (channel !== this && channel.name === this.name) {
        channel.onmessage?.({ data } as MessageEvent<unknown>);
      }
    }
  }

  close(): void {
    FakeBroadcastChannel.channels = FakeBroadcastChannel.channels.filter((channel) => channel !== this);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeBroadcastChannel.channels = [];
});

describe('agentStatusSync', () => {
  it('refreshes only windows observing the changed backend connection', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const local = vi.fn();
    const remote = vi.fn();
    const unsubscribeLocal = subscribeAgentStatusChanged('local', local);
    const unsubscribeRemote = subscribeAgentStatusChanged('remote-a', remote);

    broadcastAgentStatusChanged('local');

    expect(local).toHaveBeenCalledExactlyOnceWith();
    expect(remote).not.toHaveBeenCalled();
    unsubscribeLocal();
    unsubscribeRemote();
  });

  it('is a no-op when BroadcastChannel is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined);

    expect(() => broadcastAgentStatusChanged('local')).not.toThrow();
    expect(() => subscribeAgentStatusChanged('local', vi.fn())()).not.toThrow();
  });
});
