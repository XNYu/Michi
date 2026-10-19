import { useCallback, useEffect, useRef, useState } from 'react';
import { redactRemoteLog } from 'michi-shared';
import { fetchRemoteWorkspaces, type RemoteWorkspaceSummary } from '../../../../services/api/remoteWorkspaces';

export type RemoteWorkspacesState =
  | { status: 'loading' }
  | { status: 'ready'; workspaces: RemoteWorkspaceSummary[] }
  | { status: 'error'; message: string };

/** Component-scoped only: reopening Connections always reads the remote again. */
export function useRemoteWorkspaces(connectionId: string) {
  const [state, setState] = useState<RemoteWorkspacesState>({ status: 'loading' });
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ status: 'loading' });
    try {
      const workspaces = await fetchRemoteWorkspaces(connectionId, controller.signal);
      if (controller.signal.aborted) return;
      setState({ status: 'ready', workspaces });
      return workspaces;
    } catch (error) {
      if (!controller.signal.aborted) {
        setState({ status: 'error', message: redactRemoteLog(error instanceof Error ? error.message : String(error)) });
      }
    }
  }, [connectionId]);

  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);

  return { state, refresh };
}
