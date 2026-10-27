import { backendEntityId } from '../../config/backendIdentity';

export interface ExactPageSource {
  kind: 'chat' | 'helper';
  nodeId: string;
  turnId: string;
  assistantId: string;
}

const pendingHelperSources = new Map<string, ExactPageSource>();
function helperSourceKey(identity: { backendConnectionId: string; workspaceId: string }, pageId: string): string {
  return `${identity.backendConnectionId}\u0000${identity.workspaceId}\u0000${pageId}`;
}

/** Queue an exact source jump until the page's embedded helper has mounted. */
export function queuePageHelperSource(identity: { backendConnectionId: string; workspaceId: string }, pageId: string, source: ExactPageSource): void {
  pendingHelperSources.set(helperSourceKey(identity, pageId), source);
  window.dispatchEvent(new CustomEvent('michi:page-helper-source', { detail: { ...identity, pageId } }));
}

/** Consume only a request matching this page's currently bound helper node. */
export function consumePageHelperSource(
  identity: { backendConnectionId: string; workspaceId: string }, pageId: string, helperNodeId: string,
): ExactPageSource | null {
  const key = helperSourceKey(identity, pageId);
  const source = pendingHelperSources.get(key);
  if (!source || source.nodeId !== helperNodeId) return null;
  pendingHelperSources.delete(key);
  return source;
}

export function resetPageHelperSourcesForTests(): void { pendingHelperSources.clear(); }

/** Reveal the source chat, then ask its pane to load/scroll to the exact answer message. */
export async function revealPageSource(
  identity: { backendConnectionId: string; workspaceId: string },
  source: ExactPageSource,
  revealBackendNode: (workspaceId: string, nodeId: string) => Promise<boolean>,
  helperRoute?: { pageId: string; open: () => void },
): Promise<boolean> {
  const workspaceId = backendEntityId(identity.backendConnectionId, identity.workspaceId);
  const nodeId = backendEntityId(identity.backendConnectionId, source.nodeId);
  if (source.kind === 'helper' && helperRoute) {
    queuePageHelperSource(identity, helperRoute.pageId, { ...source, nodeId });
    helperRoute.open();
    return true;
  }
  if (!await revealBackendNode(workspaceId, nodeId)) return false;
  await new Promise<void>((resolve) => {
    const dispatch = () => {
      window.dispatchEvent(new CustomEvent('michi:scroll-to-message', {
        detail: { nodeId, messageId: source.assistantId, messageIdx: -1 },
      }));
      resolve();
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(dispatch);
    else window.setTimeout(dispatch, 0);
  });
  return true;
}
