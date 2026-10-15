import { useEffect, useState } from 'react';

interface CrewStatus { approvals: boolean; mcpDeclared: boolean; mcpRouted: boolean; unavailable?: boolean }

export function useCrewIntegration(apiBase: string, enabled: boolean) {
  const [status, setStatus] = useState<{ apiBase: string; value: CrewStatus } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const refresh = () => {
      void fetch(`${apiBase}/crew/status`, { signal: controller.signal }).then(async (res) => {
        if (!res.ok) throw new Error('Crew status unavailable');
        const body = await res.json();
        if (!controller.signal.aborted) setStatus({ apiBase, value: {
          approvals: body.approvals === true, mcpDeclared: body.mcpDeclared === true, mcpRouted: body.mcpRouted === true,
        } });
      }).catch(() => { if (!controller.signal.aborted) setStatus({ apiBase, value: {
        approvals: false, mcpDeclared: false, mcpRouted: false, unavailable: true,
      } }); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); };
  }, [apiBase, enabled]);
  return status?.apiBase === apiBase ? status.value : null;
}
