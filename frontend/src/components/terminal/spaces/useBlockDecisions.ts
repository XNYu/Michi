import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parsePageBlockInput, type MichiPageBlock, type PageBlock, type PageBlockInput, type PageDto, type PageEditOp } from 'michi-shared';
import { contentOnly } from './nativeBlockAdapter';
import type { ApplyResult } from '../content/page/BlockFrame';

/** A decision on the page, drawn ahead of the saved block: the block as decided, and the block's revision it was made on. */
interface Decision { block: MichiPageBlock; baseRev: number }

/** Why a decision on a block was not saved; shown on that block until the next decision on it saves. */
export interface DecisionNote { blockId: string; text: string }

const NOTE_MS = 8_000;
const CHANGED = 'Not saved: this block changed meanwhile. Check it and decide again.';

/** A block's content, without what the page keeps about it. */
function blockContent(block: MichiPageBlock | PageBlock): PageBlockInput | null {
  return parsePageBlockInput(contentOnly(block));
}

const sameContent = (a: PageBlockInput | null, b: PageBlockInput | null) => a !== null && JSON.stringify(a) === JSON.stringify(b);

const refusal = (result: ApplyResult): string => result === 'gone' ? 'Not saved: this page is no longer here.'
  : result === 'stale' ? 'Not saved: the page changed meanwhile. Try again.' : 'Not saved. Try again.';

/**
 * Picks, ticks and kept versions on a native page. Each shows at once; they
 * save one at a time in the order made, each on the page as the save before
 * it left it, since the page takes one revision per write. A newer decision
 * on a block replaces one still waiting. A decision goes only onto the block
 * it was made on, or onto what its own block's earlier decision saved: one
 * whose block someone else changed meanwhile, or that the page refuses, is
 * taken back with a note on its block.
 */
export function useBlockDecisions(page: PageDto, onEdit: (ops: PageEditOp[], revision: number) => Promise<ApplyResult>, readOnly: boolean) {
  const [decided, setDecided] = useState<ReadonlyMap<string, Decision>>(() => new Map());
  const [note, setNote] = useState<DecisionNote | null>(null);
  const [settled, setSettled] = useState(0);
  const pageRef = useRef(page);
  pageRef.current = page;
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const decidedRef = useRef(decided);
  decidedRef.current = decided;
  /** Decisions waiting for the save before them, by block, in the order made. */
  const waiting = useRef(new Map<string, Decision>());
  /** The block whose save is on its way; one at a time. */
  const saving = useRef<string | null>(null);
  /** What each block's last saved decision made it, so a decision made on top of that one may follow it. */
  const savedAs = useRef(new Map<string, PageBlockInput>());

  const forget = useCallback((id: string) => setDecided((current) => {
    if (!current.has(id) || waiting.current.has(id)) return current;
    const left = new Map(current);
    left.delete(id);
    return left;
  }), []);

  const flush = useCallback(() => {
    while (!saving.current && waiting.current.size) {
      const [id, decision] = waiting.current.entries().next().value as [string, Decision];
      waiting.current.delete(id);
      const current = pageRef.current;
      const native = current.blocks.find((block) => block.id === id);
      const next = blockContent(decision.block);
      if (!native || !next || next.type !== native.type) { forget(id); continue; }
      if (native.rev !== decision.baseRev && !sameContent(savedAs.current.get(id) ?? null, blockContent(native))) {
        forget(id);
        setNote({ blockId: id, text: CHANGED });
        continue;
      }
      saving.current = id;
      const settle = (result: ApplyResult) => {
        saving.current = null;
        if (result === 'ok') {
          savedAs.current.set(id, next);
          setNote((shown) => (shown?.blockId === id ? null : shown));
        } else {
          forget(id);
          setNote({ blockId: id, text: refusal(result) });
        }
        // The next decision goes once this render shows the page the save left (one that changed nothing, too).
        setSettled((n) => n + 1);
      };
      void onEditRef.current([{ op: 'update', id, block: next, expectRev: native.rev }], current.revision).then(settle, () => settle('failed'));
    }
  }, [forget]);

  const decide = useCallback((display: MichiPageBlock, next: MichiPageBlock) => {
    if (readOnly || typeof display.id !== 'string' || !display.id) return;
    const id = display.id;
    const native = pageRef.current.blocks.find((block) => block.id === id);
    if (!native) return;
    // Made on what the person sees: the block, or their own decision on it still on its way.
    const decision: Decision = { block: next, baseRev: decidedRef.current.get(id)?.baseRev ?? native.rev };
    waiting.current.delete(id);
    waiting.current.set(id, decision);
    setDecided((current) => new Map(current).set(id, decision));
    flush();
  }, [flush, readOnly]);

  useEffect(() => { flush(); }, [flush, page.revision, settled]);

  // A saved block replaces its decision once nothing more is on its way for it.
  useEffect(() => {
    setDecided((current) => {
      const kept = [...current].filter(([id]) => saving.current === id || waiting.current.has(id));
      return kept.length === current.size ? current : new Map(kept);
    });
  }, [page.blocks, settled]);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote((current) => (current === note ? null : current)), NOTE_MS);
    return () => window.clearTimeout(timer);
  }, [note]);

  /** The block to draw for a stored block: the person's decision on it while that is on its way, else null. */
  const display = useMemo(() => (id: string): MichiPageBlock | null => decided.get(id)?.block ?? null, [decided]);

  return { display, decide, note };
}
