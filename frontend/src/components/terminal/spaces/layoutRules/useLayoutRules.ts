import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageLayoutRule } from 'michi-shared';
import { deleteLayoutRule, fetchLayoutRules } from '../../../../services/api/spacesHome';
import { notifyPageChanged, type PageEventIdentity } from '../../../../state/pages/pageEvents';
import { subscribeAssistant } from '../../../../state/assistant/assistantStore';

export interface LayoutRulesState {
  /** Null until the first read answers. */
  rules: PageLayoutRule[] | null;
  error: string | null;
  /** `report`: the user asked, so a failed read is shown; a background read fails quietly. */
  refresh: (options?: { report?: boolean }) => void;
  remove: (ruleId: string) => Promise<void>;
}

const sameIds = (a: readonly PageLayoutRule[], b: readonly PageLayoutRule[]) =>
  a.length === b.length && a.every((rule, index) => rule.id === b[index]?.id);

/**
 * A page's layout rules. Read on mount, on page events for the page and after
 * each Meta agent window turn (the assistant store answers then). When the
 * rules changed since the last read, the page's readers are told, so the
 * Home's counted sections re-lay out as soon as the window's turn ends.
 */
export function useLayoutRules(pageId: string | null, backendConnectionId: string, reportInitialError = false): LayoutRulesState {
  const [rules, setRules] = useState<PageLayoutRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const known = useRef<PageLayoutRule[] | null>(null);
  const controller = useRef<AbortController | null>(null);

  const announce = useCallback(() => {
    if (pageId) notifyPageChanged({ backendConnectionId, pageId });
  }, [backendConnectionId, pageId]);

  const refresh = useCallback((options: { report?: boolean } = {}) => {
    if (!pageId) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    if (options.report) setError(null);
    fetchLayoutRules(pageId, backendConnectionId, current.signal).then((next) => {
      if (current.signal.aborted) return;
      const before = known.current;
      known.current = next;
      setRules(next);
      setError(null);
      if (before && !sameIds(before, next)) announce();
    }, (cause: unknown) => {
      // A background read keeps the last rules quietly; only a read the user asked for says it failed.
      if (current.signal.aborted || !options.report) return;
      setError(cause instanceof Error && cause.message ? cause.message : 'Could not read the layout rules.');
    });
  }, [announce, backendConnectionId, pageId]);

  useEffect(() => {
    known.current = null;
    setRules(null);
    setError(null);
    refresh({ report: reportInitialError });
    return () => controller.current?.abort();
  }, [refresh, reportInitialError]);

  useEffect(() => {
    if (!pageId) return undefined;
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<PageEventIdentity>).detail;
      if (!detail || detail.backendConnectionId !== backendConnectionId || (detail.pageId && detail.pageId !== pageId)) return;
      refresh();
    };
    const onAssistant = () => refresh();
    window.addEventListener('michi:page-changed', onChanged);
    const unsubscribe = subscribeAssistant(onAssistant);
    return () => {
      window.removeEventListener('michi:page-changed', onChanged);
      unsubscribe();
    };
  }, [backendConnectionId, pageId, refresh]);

  const remove = useCallback(async (ruleId: string) => {
    if (!pageId) return;
    const kept = await deleteLayoutRule(pageId, ruleId, backendConnectionId);
    known.current = kept;
    setRules(kept);
    announce();
  }, [announce, backendConnectionId, pageId]);

  return { rules, error, refresh, remove };
}
