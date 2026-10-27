import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentSandboxMethod } from 'michi-shared';
import { callPageComponentCapability, mintPageComponentCapability, revokePageComponentCapability, type ComponentHost } from '../../../../services/api/pageComponents';
import { backendEntityId, serverEntityId } from '../../../../config/backendIdentity';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';

function isRevokedOrExpiredCapability(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const apiError = error as { status?: unknown; code?: unknown; message?: unknown };
  return apiError.status === 404 && apiError.code === 'not_found'
    && typeof apiError.message === 'string'
    && /^Component capability (?:expired|backend changed|was revoked|unavailable)$/.test(apiError.message);
}

export function useComponentCapability(input: { connectionId: string; workspaceId: string; componentId: string; version: number; host: ComponentHost; props: Record<string, unknown>; bindingKey?: unknown; enabled: boolean }) {
  const scope = JSON.stringify([input.connectionId, input.workspaceId, input.componentId, input.version, input.host]);
  const identity = JSON.stringify([scope, input.props, input.bindingKey, input.enabled]);
  const [stored, setStored] = useState<{ identity: string; scope: string; capability: string; capabilityId?: string; expiresAt?: number; error?: string } | null>(null);
  const [renewal, setRenewal] = useState(0);
  const invalidatedToken = useRef<string | null>(null);
  const storedRef = useRef(stored);
  storedRef.current = stored;
  const inputRef = useRef(input);
  inputRef.current = input;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const pausedScope = useRef<string | null>(null);
  const stopEffectRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const config = inputRef.current;
    if (!config.enabled || pausedScope.current === scope) return;
    let active = true;
    let timer: number | undefined;
    let controller: AbortController | null = null;
    let current: { capability: string; capabilityId?: string; expiresAt: number } | null = null;
    const revoke = (token?: string) => { if (token) void revokePageComponentCapability(token, config.connectionId).catch(() => undefined); };
    function scheduleRetry(delay: number) { if (active) timer = window.setTimeout(() => { void renew(); }, delay); }
    async function renew() {
      if (!active || pausedScope.current === scope) return;
      controller = new AbortController();
      try {
        const result = await mintPageComponentCapability({ workspaceId: config.workspaceId, componentId: config.componentId, version: config.version, host: config.host, props: config.props }, config.connectionId, controller.signal);
        if (!active) { revoke(result.capability); return; }
        const previous = current?.capability;
        current = { capability: result.capability, ...(result.capabilityId ? { capabilityId: result.capabilityId } : {}), expiresAt: result.expiresAt };
        invalidatedToken.current = null;
        setStored({ identity, scope, ...current });
        if (previous && previous !== result.capability) revoke(previous);
        scheduleRetry(Math.max(1_000, result.expiresAt - Date.now() - 20_000));
      } catch (error) {
        if (!active || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : 'Component capability unavailable';
        const retained = storedRef.current?.scope === scope && storedRef.current.capability ? storedRef.current : null;
        if (current && current.expiresAt > Date.now()) setStored({ identity, scope, ...current, error: message });
        else if (retained) setStored({ ...retained, identity, error: message });
        else setStored({ identity, scope, capability: '', error: message });
        scheduleRetry(current ? Math.min(10_000, Math.max(1_000, current.expiresAt - Date.now())) : 10_000);
      }
    }
    void renew();
    const stop = () => {
      if (!active) return;
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      controller?.abort();
      revoke(current?.capability);
      current = null;
      if (stopEffectRef.current === stop) stopEffectRef.current = null;
    };
    stopEffectRef.current = stop;
    return stop;
  }, [identity, renewal, scope]);
  const pause = useCallback(() => {
    pausedScope.current = scope;
    stopEffectRef.current?.();
    setStored(previous => previous?.scope === scope
      ? { ...previous, capability: '', capabilityId: undefined, error: 'Component source unavailable' }
      : { identity, scope, capability: '', error: 'Component source unavailable' });
  }, [identity, scope]);
  const call = useCallback(async (method: ComponentSandboxMethod, args: unknown[]) => {
    if (pausedScope.current === scope) throw new Error('Component source unavailable');
    const state = stored?.identity === identity ? stored : null;
    if (!state?.capability) throw new Error(state?.error ?? 'Component capability is unavailable');
    const resourceId = method === 'read.database' && args.length === 1 && typeof args[0] === 'string'
      ? serverEntityId(args[0], input.connectionId)
      : undefined;
    const bridgeArgs = method === 'navigate.page' && args.length === 1 && typeof args[0] === 'string'
      ? [serverEntityId(args[0], input.connectionId)]
      : args;
    let result: unknown;
    try {
      result = await callPageComponentCapability(state.capabilityId ?? '', state.capability, { method, ...(resourceId ? { resourceId } : {}), args: resourceId ? [] : bridgeArgs }, input.connectionId);
    } catch (error) {
      if (isRevokedOrExpiredCapability(error) && pausedScope.current !== scope
        && invalidatedToken.current !== state.capability && identityRef.current === identity) {
        const latest = storedRef.current;
        if (latest?.identity === identity && latest.capability === state.capability) {
          invalidatedToken.current = state.capability;
          setStored(previous => previous?.identity === identity && previous.capability === state.capability
            ? { ...previous, capability: '', capabilityId: undefined, error: 'Component capability expired; renewing' }
            : previous);
          // The failed request is never replayed. A new effect mints a token only;
          // the host's normal read/poll path may issue a fresh read afterward.
          setRenewal(value => value + 1);
        }
      }
      throw error;
    }
    if (method === 'navigate.page' && result && typeof result === 'object' && typeof (result as { pageId?: unknown }).pageId === 'string') {
      return { ...(result as Record<string, unknown>), pageId: backendEntityId(input.connectionId, (result as { pageId: string }).pageId) };
    }
    if (method === 'write.rows' && input.host.kind === 'database_view' && result && typeof result === 'object' &&
      (['applied', 'proposed'] as const).some(key => Array.isArray((result as Record<string, unknown>)[key]) && ((result as Record<string, unknown>)[key] as unknown[]).length > 0)) {
      notifyPageChanged({ backendConnectionId: input.connectionId, workspaceId: input.workspaceId, databaseId: input.host.databaseId });
    }
    return result;
  }, [identity, input.connectionId, input.host, input.workspaceId, scope, stored]);
  const state = stored?.identity === identity || stored?.scope === scope ? stored : null;
  return { state, call, pause };
}
