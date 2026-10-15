import { useEffect, useState } from 'react';

interface CrewStatus { approvals: boolean; mcpDeclared: boolean; mcpRouted: boolean; unavailable?: boolean;
  updateRequired?: boolean; installedVersion?: string; expectedVersion?: string }

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
          updateRequired: body.updateRequired === true,
          installedVersion: typeof body.installedVersion === 'string' ? body.installedVersion : undefined,
          expectedVersion: typeof body.expectedVersion === 'string' ? body.expectedVersion : undefined,
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

export function CrewAppSetupNotice({ apiBase }: { apiBase: string }) {
  const status = useCrewIntegration(apiBase, true);
  if (!status?.updateRequired) return null;
  return <div role="status" className="mb-4 rounded-lg border border-line bg-surface p-3 text-sm text-fg">
    <p className="font-medium">Update the Crew App</p>
    <p className="mt-1 text-muted">Installed: {status.installedVersion ?? 'unknown'} · Michi expects: {status.expectedVersion}.</p>
    <p className="mt-1">After updating Michi, open Crew Apps and Sync <strong>michi-crew-runtime</strong>.
      If its source is a custom directory or an old temporary directory, refresh that source with the compatibility helper first.
      Complete any launch approval or Gateway restart requested by Crew.</p>
  </div>;
}
