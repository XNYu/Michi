import { useEffect, useRef } from 'react';
import { useChatActions, useChatProjects } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { getElectron } from '../../lib/electronBridge';
import { webUrl, openExternalUrl } from '../../services/openUrl';
import { backendApiBase } from '../../config/backendConnections';

export function useLinkOpening() {
  const { activeProject } = useChatProjects();
  const { openBrowserPane } = useChatActions();
  const { prefs } = usePrefs();
  const current = useRef({ activeProject, openBrowserPane, target: prefs.linkOpenTarget });
  current.current = { activeProject, openBrowserPane, target: prefs.linkOpenTarget };

  useEffect(() => {
    const open = (value: unknown) => {
      const url = webUrl(value);
      if (!url) return;
      const state = current.current;
      if (state.target !== 'external' && state.activeProject && getElectron()?.browserCreate) state.openBrowserPane(url);
      else openExternalUrl(url);
    };
    const onRequest = (event: Event) => {
      event.preventDefault();
      open((event as CustomEvent<{ url: string }>).detail?.url);
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return;
      const anchor = (event.target as Element)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute('download')) return;
      const raw = anchor.getAttribute('href') ?? '';
      // Relative links, fragments and application navigation keep their existing handlers.
      if (!/^https?:\/\//i.test(raw)) return;
      const url = webUrl(anchor.href);
      if (!url) return;
      event.preventDefault();
      event.stopPropagation();
      if (anchor.dataset.openExternal === 'true') openExternalUrl(url); else open(url);
    };
    window.addEventListener('michi:open-url', onRequest);
    document.addEventListener('click', onClick, true);
    document.addEventListener('auxclick', onClick, true);
    const off = getElectron()?.onOpenUrl?.(open);
    return () => {
      off?.();
      window.removeEventListener('michi:open-url', onRequest);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('auxclick', onClick, true);
    };
  }, []);

  const projectId = activeProject?.id;
  const treeId = activeProject?.activeTreeId;
  const connectionId = activeProject?.backendConnectionId;
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const id = projectId;
    const poll = async () => {
      try {
        if (document.visibilityState === 'visible') {
          const res = await fetch(`${backendApiBase(connectionId)}/workspaces/${encodeURIComponent(id)}/open-url/claim`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ treeId: treeId ?? null }), signal: controller.signal,
          });
          if (res.ok) {
            const { request } = await res.json();
            const visibleProject = current.current.activeProject;
            if (!controller.signal.aborted && document.visibilityState === 'visible'
              && visibleProject?.id === id && (visibleProject.activeTreeId ?? null) === (treeId ?? null)
              && request?.url) window.dispatchEvent(new CustomEvent('michi:open-url', { detail: { url: request.url } }));
          }
        }
      } catch { /* A disconnected backend must not trigger an external launch or retry a consumed request. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, treeId, connectionId]);
}
