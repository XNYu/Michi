import React, { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '../../state/chatStore';
import { useTerminalColors } from '../terminal/useTerminalColors';
import BottomTabBar, { type MobileTab } from './components/BottomTabBar';
import ThreadsScreen from './screens/ThreadsScreen';
import ChatScreen from './screens/ChatScreen';
import SpacesScreen from './screens/SpacesScreen';
import ContextsScreen from './screens/ContextsScreen';
import SettingsScreen from './screens/SettingsScreen';
import './styles.css';

/**
 * Top-level mobile shell. Mounted in App.tsx in place of TerminalShell when the
 * viewport is narrower than 768px. Holds two pieces of local state:
 *   tab          — which bottom-tab is active (threads/spaces/contexts/settings)
 *   currentNodeId — the node displayed by ChatScreen (mobile is single-node)
 *
 * Tab bar is hidden while a chat is open. Selecting a thread sets currentNodeId
 * and routes the user into ChatScreen. Back from ChatScreen clears it.
 */
export default function MobileShell() {
  const cssVars = useTerminalColors();
  const [tab, setTab] = useState<MobileTab>('threads');
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const { activeProjectId, setFocusedNodeId, focusedNodeId } = useChatStore();

  // Mirror palette vars onto <html> so portal-rendered popups (sonner toaster)
  // resolve var(--term-*) correctly. Same trick TerminalShell uses.
  useEffect(() => {
    const root = document.documentElement;
    const keys = Object.keys(cssVars);
    for (const k of keys) root.style.setProperty(k, cssVars[k]);
    return () => {
      for (const k of keys) root.style.removeProperty(k);
    };
  }, [cssVars]);

  // Switching workspaces always lands on Threads with no chat open. Without
  // this guard, a stale currentNodeId could point at a node from the prior
  // workspace and ChatScreen would render its messages.
  useEffect(() => {
    setCurrentNodeId(null);
    setTab('threads');
  }, [activeProjectId]);

  // Keep store-level focusedNodeId synced. Some selectors (search highlight,
  // export panel) read it directly; sticking to one source of truth keeps
  // them working transparently on mobile. Guard against the redundant write
  // when the store already matches — otherwise we stomp focus that other
  // shells may have set during a viewport-resize hand-off.
  useEffect(() => {
    if (focusedNodeId !== currentNodeId) setFocusedNodeId(currentNodeId);
  }, [currentNodeId, focusedNodeId, setFocusedNodeId]);

  const enterChat = useCallback((nodeId: string) => {
    setCurrentNodeId(nodeId);
  }, []);

  const exitChat = useCallback(() => {
    setCurrentNodeId(null);
    setTab('threads');
  }, []);

  // When a chat is open, ChatScreen takes the whole shell (no tab bar).
  if (currentNodeId) {
    return (
      <div className="m-shell">
        <ChatScreen
          nodeId={currentNodeId}
          onNavigateNode={setCurrentNodeId}
          onExit={exitChat}
        />
      </div>
    );
  }

  return (
    <div className="m-shell">
      <div className="m-shell-body">
        {tab === 'threads' && (
          <ThreadsScreen onOpenThread={enterChat} />
        )}
        {tab === 'spaces' && (
          <SpacesScreen
            onPicked={() => setTab('threads')}
          />
        )}
        {tab === 'contexts' && <ContextsScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </div>
      <BottomTabBar active={tab} onChange={setTab} />
    </div>
  );
}

/**
 * Resolve the "default" node a user lands on when entering a thread. We pick
 * the most-recently-active leaf under the tree's root, falling back to the
 * root itself.
 */
export function resolveLeafForTree(
  rootNodeId: string,
  edges: ReadonlyArray<{ source: string; target: string; kind?: string }>,
  nodes: Record<string, { deletedAt?: number; messages?: unknown[] }>,
): string {
  // Walk down picking the child with the most messages until we hit a leaf.
  // This isn't perfect — "lastActive" would be better — but messages.length
  // is a fine proxy and avoids extra timestamps.
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind && e.kind !== 'branch') continue;
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }
  let cur = rootNodeId;
  for (let i = 0; i < 256; i++) {
    const kids = (childrenOf.get(cur) ?? []).filter(
      (id) => !nodes[id]?.deletedAt,
    );
    if (kids.length === 0) return cur;
    let best = kids[0];
    let bestLen = nodes[best]?.messages?.length ?? 0;
    for (const k of kids) {
      const len = nodes[k]?.messages?.length ?? 0;
      if (len > bestLen) {
        best = k;
        bestLen = len;
      }
    }
    cur = best;
  }
  return cur;
}

