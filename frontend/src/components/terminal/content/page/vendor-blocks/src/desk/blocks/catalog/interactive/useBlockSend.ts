// Native adapter. No Desk service, project identity or global assistant routing.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageBlockWithSources } from '../../../../../shared/desk-blocks';
import type { BlockCtx } from '../../types';
export const LOCK_MS = 2000;
export function useBlockSend(block: PageBlockWithSources, ctx: BlockCtx) {
  const [locked, setLocked] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const busy = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const request = ctx.requestAssistant;
  const send = block.type === 'poll' || block.type === 'choice';
  const fire = useCallback((prompt: string, title: string) => {
    if (busy.current || !request) return false;
    busy.current = true;
    if (!request(block, prompt, title, send)) { busy.current = false; return false; }
    setLocked(true);
    timer.current = setTimeout(() => { busy.current = false; setLocked(false); }, LOCK_MS);
    return true;
  }, [block, request, send]);
  return { available: !!request, locked, fire, sentLabel: send ? 'Sent' : 'Added to the assistant' };
}
