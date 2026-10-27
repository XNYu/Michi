import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useChatActions, useChatProjects } from '../chatStore';
import { createProgressCard } from '../../services/api/spacesHome';
import { dropPending, markPendingCreated, useSpaceConversationState, type PendingStart } from './store';

/** How long a start waits for its workspace to become the active one. */
export const START_SWITCH_TIMEOUT_MS = 5_000;
/** The new conversation reaches the backend shortly after its first message; until then its card cannot be recorded. */
const REGISTER_ATTEMPTS = 12;
const REGISTER_BACKOFF_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function registerCard(start: PendingStart, nodeId: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await createProgressCard(nodeId, start.startedFromPageId, start.backendConnectionId);
      return;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== 404 || attempt >= REGISTER_ATTEMPTS) throw error;
      await sleep(REGISTER_BACKOFF_MS * attempt);
    }
  }
}

/**
 * Creates the conversations the new-chat sheet asked for, the same way a new
 * chat starts in the Conversations area (so it runs on the global settings):
 * make its workspace active, create the thread, send the first message. Then
 * records its progress card. Lives in the shell so a start survives the page
 * that asked for it.
 */
export function useSpaceConversationRunner(onRegistered: () => void): void {
  const { activeProjectId } = useChatProjects();
  const { selectProject, createThread, sendMessage } = useChatActions();
  const { pending } = useSpaceConversationState();
  const handled = useRef(new Set<number>());
  const switching = useRef(new Map<number, number>());
  const onRegisteredRef = useRef(onRegistered);
  onRegisteredRef.current = onRegistered;

  useEffect(() => {
    for (const start of pending) {
      if (start.nodeId || handled.current.has(start.id)) continue;
      if (activeProjectId !== start.workspaceId) {
        if (!switching.current.has(start.id)) {
          switching.current.set(start.id, window.setTimeout(() => {
            if (handled.current.has(start.id)) return;
            handled.current.add(start.id);
            dropPending(start.id);
            toast.error('Couldn’t switch to that workspace to start the chat');
          }, START_SWITCH_TIMEOUT_MS));
          selectProject(start.workspaceId);
        }
        continue;
      }
      handled.current.add(start.id);
      window.clearTimeout(switching.current.get(start.id));
      switching.current.delete(start.id);
      const nodeId = createThread();
      if (!nodeId) {
        dropPending(start.id);
        toast.error('Couldn’t start the chat');
        continue;
      }
      sendMessage(nodeId, start.text);
      markPendingCreated(start.id, nodeId);
      registerCard(start, nodeId).then(
        () => onRegisteredRef.current(),
        (error: unknown) => {
          dropPending(start.id);
          toast.error('The chat started, but its progress can’t be shown on the page', {
            description: error instanceof Error ? error.message : undefined,
          });
        },
      );
    }
  }, [activeProjectId, createThread, pending, selectProject, sendMessage]);

  useEffect(() => {
    const timers = switching.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
}
