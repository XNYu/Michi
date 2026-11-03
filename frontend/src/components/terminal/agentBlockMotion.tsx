import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, PresenceContext, motion, useIsPresent, type TargetAndTransition } from 'motion/react';
import { DUR, EASE, SPRING } from '../../motion/tokens';

/**
 * Motion for the agent blocks: tool-call groups (ToolCallGroup and the
 * AgentBlockVariants chromes), subagent lines, agent-run and workflow cards.
 *
 * Only transitions animate. Whatever is there when its list, disclosure or
 * glyph slot mounts renders settled (`AnimatePresence initial={false}`, or the
 * key/visibility seen on the first render), so hydration, remounts and
 * re-expanding a finished group never replay an entrance.
 *
 * Tool updates arrive rAF-batched many times a second. Every target here is a
 * module constant keyed to a state (present, status kind, header mode), never
 * to streamed content, so re-rendering in the same state restarts nothing.
 * CSS loops (breathing dot, shimmer, spinner) stay on the inner elements;
 * motion drives only the wrappers around them.
 */

/* ── Height reveals ──────────────────────────────────────────────────── */

const HIDDEN = { height: 0, opacity: 0, overflow: 'hidden' } as const;

const COLLAPSE: TargetAndTransition = {
  ...HIDDEN,
  transition: {
    height: { duration: DUR.collapse, ease: EASE.drawer },
    opacity: { duration: DUR.soft, ease: 'linear' },
  },
};

function opened(height: number, ease: typeof EASE.out, opacity: { duration: number; delay: number }): TargetAndTransition {
  return {
    height: 'auto',
    opacity: 1,
    transition: { height: { duration: height, ease }, opacity: { ...opacity, ease: 'linear' } },
    // Clip only while moving: a settled body keeps its focus rings.
    transitionEnd: { overflow: 'visible' },
  };
}

/**
 * A click in the transcript records its height for two frames; a follow-mode
 * pin that finds it changed leaves follow mode instead of throwing the view to
 * the tail (TPane `userClickLayoutRef`). A tween's first frame samples t=0, so
 * a body opening from 0px or closing from its own height would first move a
 * frame too late. Bodies the user toggles therefore change height in the
 * click's own commit: they open from 1px and close from 1px under their height.
 */
const HIDDEN_BY_HAND = { ...HIDDEN, height: 1 } as const;

const REVEAL = {
  /** Tool payloads: "collapse fast, expand soft" (260ms / 160ms). */
  disclosure: { from: HIDDEN_BY_HAND, byHand: true, enter: opened(DUR.expand, EASE.drawer, { duration: 0.16, delay: 0.04 }), exit: COLLAPSE },
  /** A group body the user opens (240ms); closing, by hand or at the end, is 160ms. */
  group: { from: HIDDEN_BY_HAND, byHand: true, enter: opened(0.24, EASE.drawer, { duration: 0.16, delay: 0.04 }), exit: COLLAPSE },
  /** A row, header or section arriving while live (160ms ease-out). */
  arrive: { from: HIDDEN, byHand: false, enter: opened(0.16, EASE.out, { duration: 0.12, delay: 0.03 }), exit: COLLAPSE },
} as const;

type RevealPreset = keyof typeof REVEAL;

const FLOW_ROOT: React.CSSProperties = { display: 'flow-root' };

/**
 * A height-animated body. While it leaves it is out of the a11y tree and
 * inert. `flow-root` keeps child margins inside it whether or not it clips,
 * so its measured height is the height it collapses from.
 */
function RevealBody({ preset, children }: { preset: RevealPreset; children: React.ReactNode }) {
  const present = useIsPresent();
  const ref = useRef<HTMLDivElement>(null);
  const { from, byHand, enter, exit } = REVEAL[preset];
  // The height a by-hand body collapses from, measured once, on the render
  // that starts its exit (the DOM still has its full height then).
  const exitFromRef = useRef<number | null>(null);
  if (present) exitFromRef.current = null;
  else if (byHand && exitFromRef.current === null) exitFromRef.current = Math.max(0, (ref.current?.offsetHeight ?? 0) - 1);
  const exitFrom = exitFromRef.current;
  useLayoutEffect(() => {
    const el = ref.current;
    if (present || !el || exitFromRef.current === null) return;
    // Motion's first frame writes the same value; this lands it in the commit.
    el.style.overflow = 'hidden';
    el.style.height = `${exitFromRef.current}px`;
  }, [present]);
  return (
    <motion.div
      ref={ref}
      initial={from}
      animate={enter}
      exit={exitFrom === null ? exit : { ...exit, height: [exitFrom, 0] }}
      aria-hidden={present ? undefined : true}
      inert={!present}
      data-reveal={preset}
      style={FLOW_ROOT}
    >
      {children}
    </motion.div>
  );
}

/**
 * Shows/hides `children` with a height + opacity disclosure. Present on the
 * first render: shown settled.
 */
export function Reveal({ show, preset = 'disclosure', children }: {
  show: boolean;
  preset?: RevealPreset;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence initial={false}>
      {show && <RevealBody key="reveal" preset={preset}>{children}</RevealBody>}
    </AnimatePresence>
  );
}

export interface RevealRow {
  key: string;
  node: React.ReactNode;
}

/**
 * Rows that grow in (height 0→auto + fade) when they arrive and collapse when
 * they leave. Rows there when the list mounts render settled. `gap` is
 * padding inside each row's animated box, so it grows in with the row
 * instead of appearing at once like a flex gap.
 */
export function RevealList({ rows, gap = 0 }: { rows: readonly RevealRow[]; gap?: number }) {
  return (
    <AnimatePresence initial={false}>
      {rows.map((row, i) => (
        <RevealBody key={row.key} preset="arrive">
          <div style={{ paddingTop: i > 0 ? gap : 0 }}>{row.node}</div>
        </RevealBody>
      ))}
    </AnimatePresence>
  );
}

const SCROLL_MAX_HEIGHT = 400;
/** How long a new row keeps a scrolled list pinned while it grows in. */
const PIN_MS = 260;

/**
 * A RevealList that scrolls past `scroll` and stays pinned to the newest row
 * unless the user scrolled away. A new row starts at height 0, so the list
 * re-pins every frame while it grows; opening a payload does not scroll.
 */
export function ScrollingRevealList({ rows, gap, scroll }: {
  rows: readonly RevealRow[];
  gap?: number;
  scroll: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const count = rows.length;
  useEffect(() => {
    const el = listRef.current;
    if (!el || !scroll || !stickyRef.current) return;
    const until = performance.now() + PIN_MS;
    let frame = 0;
    const pin = () => {
      if (!stickyRef.current) return;
      el.scrollTop = el.scrollHeight;
      if (performance.now() < until) frame = requestAnimationFrame(pin);
    };
    pin();
    return () => cancelAnimationFrame(frame);
  }, [count, scroll]);
  return (
    <div
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className={scroll ? 'term-scrollbar' : undefined}
      style={scroll ? { maxHeight: SCROLL_MAX_HEIGHT, overflowY: 'auto' } : undefined}
    >
      <RevealList rows={rows} gap={gap} />
    </div>
  );
}

/**
 * A section that appears after its card mounted grows in (160ms); one shown
 * from the start renders settled. Hiding is immediate: nothing lingers.
 */
export function RevealOnShow({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [shownAtMount] = useState(show);
  if (!show) return null;
  return (
    <OwnEntrance>
      <motion.div initial={shownAtMount ? false : HIDDEN} animate={REVEAL.arrive.enter} style={FLOW_ROOT}>{children}</motion.div>
    </OwnEntrance>
  );
}

/* ── Glyphs and labels ───────────────────────────────────────────────── */

const SCALE_FROM = { opacity: 0, scale: 0.5 } as const;
const SCALE_IN: TargetAndTransition = { opacity: 1, scale: 1, transition: SPRING.snappy };
const SCALE_OUT: TargetAndTransition = { opacity: 0, scale: 0.5, transition: { duration: DUR.soft, ease: EASE.out } };
const GLYPH_LAYER: React.CSSProperties = { gridArea: '1 / 1', display: 'inline-flex', alignItems: 'center' };

function GlyphLayer({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.span initial={SCALE_FROM} animate={SCALE_IN} exit={SCALE_OUT} style={GLYPH_LAYER} aria-hidden={present ? undefined : true}>
      {children}
    </motion.span>
  );
}

/**
 * A status glyph slot. When `glyph` (the kind: running, done, failed…)
 * changes, the old glyph shrinks out in 100ms while the new one springs in;
 * the first glyph renders settled. Glyph content sets its own aria-hidden.
 */
export function GlyphSwap({ glyph, justify = 'start', style, children }: {
  glyph: string;
  justify?: 'start' | 'center' | 'end';
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <span style={{ display: 'inline-grid', alignItems: 'center', justifyItems: justify, flexShrink: 0, ...style }}>
      <AnimatePresence initial={false}>
        <GlyphLayer key={glyph}>{children}</GlyphLayer>
      </AnimatePresence>
    </span>
  );
}

const DRAW_FROM = { pathLength: 0 } as const;
const DRAW_TO: TargetAndTransition = { pathLength: 1, transition: { duration: 0.22, ease: EASE.out } };

/** An SVG stroke drawn in (220ms) when its glyph swaps in; settled otherwise. */
export function DrawnPath({ d }: { d: string }) {
  return <motion.path d={d} initial={DRAW_FROM} animate={DRAW_TO} />;
}

const LABEL_FROM = { opacity: 0, y: 4 } as const;
const LABEL_IN: TargetAndTransition = { opacity: 1, y: 0, transition: { duration: DUR.enter, ease: EASE.out, delay: 0.03 } };
const LABEL_OUT: TargetAndTransition = { opacity: 0, y: -4, transition: { duration: 0.12, ease: EASE.out } };

function LabelLayer({ style, children }: { style?: React.CSSProperties; children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.span
      initial={LABEL_FROM}
      animate={LABEL_IN}
      exit={LABEL_OUT}
      aria-hidden={present ? undefined : true}
      style={{ gridArea: '1 / 1', minWidth: 0, ...style }}
    >
      {children}
    </motion.span>
  );
}

/**
 * A header label that cross-fades when `k` (its mode: running, done,
 * collapsed…) changes, e.g. "running tools" into the collapsed summary. Text
 * updates within one mode render in place. The outgoing label is aria-hidden.
 */
export function LabelSwap({ k, style, layerStyle, children }: {
  k: string;
  style?: React.CSSProperties;
  layerStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <span style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, ...style }}>
      <AnimatePresence initial={false}>
        <LabelLayer key={k} style={layerStyle}>{children}</LabelLayer>
      </AnimatePresence>
    </span>
  );
}

const FADE_FROM = { opacity: 0 } as const;
const FADE_IN: TargetAndTransition = { opacity: 1, transition: { duration: 0.16, ease: 'linear' } };

/**
 * Status words and small inline marks: when `k` changes the new content fades
 * in (`variant="scale"`: springs in from half size); `null` renders nothing.
 * The content shown on the first render, and a later return to it, render
 * settled. The old content goes at once, so a status word never appears
 * twice in a line's text or accessible name.
 */
export function FadeOnChange({ k, variant = 'fade', style, className, children }: {
  k: string | null;
  variant?: 'fade' | 'scale';
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
}) {
  const [mountKey] = useState(k);
  if (k === null) return null;
  const from = variant === 'scale' ? SCALE_FROM : FADE_FROM;
  const to = variant === 'scale' ? SCALE_IN : FADE_IN;
  return (
    <OwnEntrance>
      <motion.span key={k} initial={k === mountKey ? false : from} animate={to} style={style} className={className}>
        {children}
      </motion.span>
    </OwnEntrance>
  );
}

const FLASH_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--term-danger)',
  pointerEvents: 'none',
};
const FLASH_FROM = { opacity: 0.14 } as const;
const FLASH_TO: TargetAndTransition = { opacity: 0, transition: { duration: DUR.slow, ease: 'easeOut' } };

/**
 * One danger-tinted fade (600ms) over a row that fails while shown. A row
 * failed when it mounted does not flash. The parent must be positioned.
 */
export function FailFlash({ failed }: { failed: boolean }) {
  const [failedAtMount] = useState(failed);
  if (!failed || failedAtMount) return null;
  return (
    <OwnEntrance>
      <motion.span aria-hidden data-fail-flash="" initial={FLASH_FROM} animate={FLASH_TO} style={FLASH_STYLE} />
    </OwnEntrance>
  );
}

/**
 * An AnimatePresence child memoises its first-render `initial={false}` for
 * every motion descendant, including ones that mount later. Elements that
 * decide their own entrance (and never need an exit) opt out of it.
 */
function OwnEntrance({ children }: { children: React.ReactNode }) {
  return <PresenceContext.Provider value={null}>{children}</PresenceContext.Provider>;
}
