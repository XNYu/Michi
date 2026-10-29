import { useCallback, useEffect, useRef, useState } from 'react';
import type { MichiAssistantConversations } from 'michi-shared';
import { activateAssistantConversation, fetchAssistantConversations } from '../../../services/api/assistant';
import { adoptAssistantInfo, useAssistantSnapshot } from '../../../state/assistant/assistantStore';
import { useChatActions, useStructuralSelector } from '../../../state/chatStore';
import { fetchWorkspace } from '../../../services/api/persistence';

/** Recent conversations live under Assistant; expanding loads five more from the durable history. */
export function AssistantHistory({ onOpenAssistant, visible = false }: { onOpenAssistant(): void; visible?: boolean }) {
  const snap = useAssistantSnapshot();
  const nodeId = snap.info?.nodeId;
  const { installWorkspaceSnapshot } = useChatActions();
  const status = useStructuralSelector(useCallback(nodes => nodeId ? nodes[nodeId]?.status : undefined, [nodeId]));
  const [history, setHistory] = useState<MichiAssistantConversations>({ items: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    if (!visible || snap.status !== 'ready') return () => controller.abort();
    setLoading(true);
    setError(null);
    void fetchAssistantConversations(undefined, controller.signal).then(result => {
      if (current === generation.current) setHistory(previous => previous.items.length > 5 ? {
        items: [...result.items, ...previous.items.filter(item => !result.items.some(recent => recent.nodeId === item.nodeId))],
        nextCursor: previous.nextCursor,
      } : result);
    }, cause => {
      if (!controller.signal.aborted && current === generation.current) setError(cause instanceof Error ? cause.message : 'Could not load history');
    }).finally(() => { if (!controller.signal.aborted && current === generation.current) setLoading(false); });
    return () => controller.abort();
  }, [visible, nodeId, snap.status, status, retry]);

  const more = async () => {
    if (!history.nextCursor || loading) return;
    const current = generation.current;
    setLoading(true); setError(null);
    try {
      const next = await fetchAssistantConversations(history.nextCursor);
      if (current === generation.current) setHistory(previous => ({
        items: [...previous.items, ...next.items.filter(item => !previous.items.some(saved => saved.nodeId === item.nodeId))], nextCursor: next.nextCursor,
      }));
    } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Could not load history'); }
    finally { if (current === generation.current) setLoading(false); }
  };
  const open = async (id: string) => {
    if (!nodeId || busy.current) return;
    if (id === nodeId) { onOpenAssistant(); return; }
    busy.current = true; setSwitching(id); setError(null);
    try {
      const info = await activateAssistantConversation(id, nodeId);
      // A previously loaded archived tree must become writable in the authoritative store too.
      const started = Date.now();
      const workspace = await fetchWorkspace(info.workspaceId).catch(cause => {
        // Activation already succeeded on the server; let the embedded loader retry
        // this conversation rather than leave subsequent activations using a stale ID.
        adoptAssistantInfo(info);
        throw cause;
      });
      installWorkspaceSnapshot(workspace, started);
      // Keep the current conversation visible until its replacement is installed.
      adoptAssistantInfo(info);
      onOpenAssistant();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open conversation'); }
    finally { busy.current = false; setSwitching(null); }
  };
  if (!visible) return null;

  return <nav className="spaces-assistant-history" aria-label="Assistant conversations" aria-busy={loading || switching !== null}>
    {history.items.map(item => <button type="button" key={item.nodeId} className="area-side__row spaces-assistant-history__row"
      title={item.title} aria-current={visible && item.nodeId === nodeId ? 'page' : undefined}
      disabled={switching !== null || (status === 'streaming' && item.nodeId !== nodeId)} onClick={() => { void open(item.nodeId); }}>
      <span className="area-side__label">{item.title}</span>
      <time dateTime={new Date(item.updatedAt).toISOString()} title={new Date(item.updatedAt).toLocaleString()}>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
    </button>)}
    {history.nextCursor && <button type="button" className="spaces-assistant-history__more" disabled={loading} onClick={() => { void more(); }}>{loading ? 'Loading…' : 'Show more'}</button>}
    {error && <div className="area-side__note" role="alert">{error} <button type="button" onClick={() => { setRetry(value => value + 1); }}>Retry</button></div>}
  </nav>;
}
