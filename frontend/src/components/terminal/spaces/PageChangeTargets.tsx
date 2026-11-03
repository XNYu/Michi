import React from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from 'motion/react';
import type { PageChangeDto } from 'michi-shared';
import { EASE } from '../../../motion/tokens';
import { ChangeCard, isPageChangeRedoable, isPageChangeRevertible, type AcceptedPageEdit } from './ChangeCard';
import type { ExactPageSource } from './SourceTrace';
import { buildPageChangeIndex, changeTargetKey } from './changeIndex';

export type PageChangeTargetFilter =
  | { kind: 'block'; pageId: string; blockId: string }
  | { kind: 'database'; databaseId: string };

export function pageChangesForTarget(changes: readonly PageChangeDto[], target: PageChangeTargetFilter): PageChangeDto[] {
  const matching = changes.filter((change) => target.kind === 'block'
    ? change.target.kind === 'block' && change.target.pageId === target.pageId && change.target.blockId === target.blockId
    : (change.target.kind === 'row' || change.target.kind === 'database') && change.target.databaseId === target.databaseId);
  const { byTarget } = buildPageChangeIndex(matching);
  const latest = [...byTarget.values()]
    .map((items) => items.reduce((latest, item) => item.seq > latest.seq ? item : latest))
    .filter((change) => change.source.kind !== 'user' && (change.proposalState !== null || isPageChangeRevertible(change) || isPageChangeRedoable(change)))
  const unresolved = matching.filter((change) => change.source.kind !== 'user' && (change.proposalState === 'pending' || change.proposalState === 'dismissed'));
  return [...new Map([...latest, ...unresolved].map((change) => [change.id, change])).values()].sort((left, right) => right.seq - left.seq);
}

/**
 * What a target shows after `change` was undone came from the change before
 * it: that change's source, or null when a person made it. Undefined when no
 * earlier change is loaded.
 */
export function sourceShownAfterUndo(change: PageChangeDto, history: readonly PageChangeDto[]): PageChangeDto['source'] | null | undefined {
  if (change.applicationState !== 'reverted') return undefined;
  const key = changeTargetKey(change);
  let before: PageChangeDto | undefined;
  for (const candidate of history) {
    if (candidate.seq >= change.seq || candidate.applicationState !== 'applied' || changeTargetKey(candidate) !== key) continue;
    if (!before || candidate.seq > before.seq) before = candidate;
  }
  if (!before) return undefined;
  return before.source.kind === 'user' ? null : before.source;
}

export interface PageChangeTargetsProps {
  changes: readonly PageChangeDto[];
  /** Every loaded change of the page, when `changes` shows only some: an undone line names what came before. */
  history?: readonly PageChangeDto[];
  target: PageChangeTargetFilter;
  onAccept: (change: PageChangeDto, edited?: AcceptedPageEdit) => void | Promise<void>;
  onDismiss: (change: PageChangeDto) => void | Promise<void>;
  onReopen: (change: PageChangeDto) => void | Promise<void>;
  onRevert: (change: PageChangeDto) => void | Promise<void>;
  onRedo: (change: PageChangeDto) => void | Promise<void>;
  onOpenSource: (source: ExactPageSource) => void | boolean | Promise<void | boolean>;
  loading: boolean;
  error: string | null;
  sourceLabel?: (source: PageChangeDto['source']) => string | undefined;
  /** Page blocks show pending suggestions only; their menu owns source navigation. */
  quiet?: boolean;
}

/** The chosen action holds this long before the answered suggestion collapses, however fast Michi answers. */
const CHOSEN_HOLD_MS = 120;
const SETTLE = { duration: 0.22, ease: EASE.drawer };
/** The gap an element sits in (its parent's row gap, whatever the CSS says now): collapsing away, it takes the gap along. */
const rowGapOf = (el: Element | null) => {
  const parent = el?.parentElement;
  return parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
};

/** When each suggestion here was answered, by change id: read when a collapse starts, not when it was drawn. */
type Answers = { still: boolean; at: Map<string, number> };
const holdFor = (answers: Answers, id?: string) => {
  const times = id === undefined ? [...answers.at.values()] : [answers.at.get(id) ?? -Infinity];
  const latest = Math.max(-Infinity, ...times);
  return Number.isFinite(latest) ? Math.max(0, CHOSEN_HOLD_MS - (performance.now() - latest)) / 1000 : 0;
};
const gone = (answers: Answers, id?: string) => (answers.still
  ? { opacity: 0, transition: { duration: 0.08 } }
  : { height: 0, opacity: 0, overflow: 'hidden', transition: { ...SETTLE, delay: holdFor(answers, id) } });

/**
 * One change under its target. Answered and gone (a quiet target shows only
 * waiting suggestions) it collapses away; answered and kept (it becomes its
 * resolved line) it settles to the line's height. Settled when first drawn.
 * While it collapses it is out of the accessibility tree and inert.
 */
function ChangeSlot({ change, answers, children }: { change: PageChangeDto; answers: Answers; children: React.ReactNode }) {
  const present = useIsPresent();
  const ref = React.useRef<HTMLDivElement>(null);
  const height = React.useRef<number | null>(null);
  const pending = change.proposalState === 'pending';
  // Only a waiting suggestion can resolve in place, so only it keeps its height: watched, not read on each render.
  React.useEffect(() => {
    const el = ref.current;
    if (!pending || !el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => { height.current = entry?.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight; });
    observer.observe(el);
    return () => observer.disconnect();
  }, [pending]);
  const wasPending = React.useRef(pending);
  React.useLayoutEffect(() => {
    const el = ref.current;
    const resolved = wasPending.current && !pending;
    wasPending.current = pending;
    const from = height.current;
    height.current = null;
    if (!resolved || !el || from === null || answers.still || typeof el.animate !== 'function') return;
    const to = el.offsetHeight;
    if (from !== to) {
      el.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${to}px`, overflow: 'hidden' }],
        { duration: SETTLE.duration * 1000, easing: `cubic-bezier(${EASE.drawer.join(',')})` });
    }
  }, [pending, answers]);
  return (
    <motion.div ref={ref} className="page-change-slot" custom={answers}
      variants={{ gone: (a: Answers) => ({ ...gone(a, change.id), marginBottom: a.still ? 0 : -rowGapOf(ref.current) }) }} exit="gone"
      aria-hidden={present ? undefined : true} inert={!present}>
      {children}
    </motion.div>
  );
}

export function PageChangeTargets({ changes = [], history, target, onAccept, onDismiss, onReopen, onRevert, onRedo, onOpenSource, loading, error, sourceLabel, quiet = false }: PageChangeTargetsProps) {
  const relevant = pageChangesForTarget(changes, target).filter(change => !quiet || change.proposalState === 'pending');
  const still = useReducedMotionConfig() === true;
  const [answers] = React.useState<Answers>(() => ({ still, at: new Map() }));
  answers.still = still;
  const onChoose = React.useCallback((change: PageChangeDto) => { answers.at.set(change.id, performance.now()); }, [answers]);
  // Most blocks have no changes and draw nothing. One whose last suggestion was just answered keeps
  // drawing until that suggestion has collapsed away.
  const has = relevant.length > 0;
  const [shown, setShown] = React.useState({ has, leaving: false });
  if (shown.has !== has) setShown({ has, leaving: !has });
  if (!has && !(shown.has !== has || shown.leaving)) return null;
  return (
    // The last suggestion answered away takes the whole list, and its margin, with it.
    <AnimatePresence initial={false} onExitComplete={() => setShown((now) => (now.has ? now : { has: false, leaving: false }))}>
      {relevant.length > 0 && (
        <TargetList key="targets" label={target.kind === 'block' ? 'Changes to this block' : 'Changes to this database'} answers={answers}>
          <AnimatePresence initial={false}>
            {relevant.map((change) => (
              <ChangeSlot key={change.id} change={change} answers={answers}>
                <ChangeCard variant="inline" quiet={quiet} sourceLabel={sourceLabel} shownSource={sourceShownAfterUndo(change, history ?? changes)} change={change} onAccept={onAccept} onDismiss={onDismiss} onReopen={onReopen} onRevert={onRevert} onRedo={onRedo} onOpenSource={onOpenSource} loading={loading} error={error} onChoose={onChoose} />
              </ChangeSlot>
            ))}
          </AnimatePresence>
        </TargetList>
      )}
    </AnimatePresence>
  );
}

function TargetList({ label, answers, children }: { label: string; answers: Answers; children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.div className="page-change-targets" aria-label={label} custom={answers}
      variants={{ gone: (a: Answers) => (a.still ? gone(a) : { ...gone(a), marginTop: 0 }) }} exit="gone"
      aria-hidden={present ? undefined : true} inert={!present}>
      {children}
    </motion.div>
  );
}
