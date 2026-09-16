const AGENT_STATUS_CHANNEL = 'michi:agent-status';

interface AgentStatusChangedMessage {
  type: 'agent-status-changed';
  connectionId: string;
}

function openChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'function'
    ? new BroadcastChannel(AGENT_STATUS_CHANNEL)
    : null;
}

export function broadcastAgentStatusChanged(connectionId: string): void {
  const channel = openChannel();
  if (!channel) return;
  channel.postMessage({ type: 'agent-status-changed', connectionId } satisfies AgentStatusChangedMessage);
  channel.close();
}

export function subscribeAgentStatusChanged(
  connectionId: string,
  onChanged: () => void,
): () => void {
  const channel = openChannel();
  if (!channel) return () => {};
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as Partial<AgentStatusChangedMessage> | null;
    if (message?.type === 'agent-status-changed' && message.connectionId === connectionId) {
      onChanged();
    }
  };
  return () => channel.close();
}
