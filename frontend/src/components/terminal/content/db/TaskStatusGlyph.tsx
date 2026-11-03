import React, { useRef } from 'react';
import { AnimatePresence, motion, useReducedMotionConfig, type Variants } from 'motion/react';
import { EASE, SPRING, TRANSITION } from '../../../../motion/tokens';

const STAGE: React.CSSProperties = { display: 'inline-grid' };
const LAYER: React.CSSProperties = { gridArea: '1 / 1', display: 'inline-flex' };
const DRAW = { duration: 0.22, ease: EASE.out };
const GLYPH: Variants = {
  enter: { scale: 0.6, opacity: 0 },
  shown: { scale: 1, opacity: 1 },
  exit: (again: boolean) => (again ? { opacity: 0, transition: { duration: 0 } } : { scale: 0.6, opacity: 0, transition: TRANSITION.exit }),
};

function Glyph({ status, size, draw }: { status: string; size: number; draw: boolean }) {
  const c = size / 2;
  const r = size / 2 - 1;
  return (
    <svg className="michi-task-status" data-status={status} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {status === 'todo' && <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.6" />}
      {status === 'doing' && <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.4" />}
      {status === 'waiting' && <circle cx={c} cy={c} r={r} fill="currentColor" />}
      {status === 'done' && (
        <motion.path d={`M${size * 0.2} ${size * 0.55} L${size * 0.42} ${size * 0.76} L${size * 0.82} ${size * 0.28}`}
          fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
          initial={draw ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={DRAW} />
      )}
      {!['todo', 'doing', 'waiting', 'done'].includes(status) && <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1" opacity="0.6" />}
    </svg>
  );
}

/**
 * A task's status as a glyph, drawn apart from conversation dots: To do a
 * dashed ring, In progress a ring, Waiting on you a filled dot, Done a check.
 * A status a person added is a faint ring.
 *
 * Drawn settled at first. A new status scales in over the old one; Done gets a
 * small overshoot and its check draws itself, and again whenever `cheer`
 * changes (a task arriving in the Done column).
 */
export function TaskStatusGlyph({ status, size = 10, cheer = '' }: { status: string; size?: number; cheer?: string }) {
  const last = useRef({ status, cheer });
  const play = useRef(0);
  // A check settling again makes way at once; another status scales out under the new one.
  const again = useRef(false);
  const swap = last.current.status !== status;
  if (swap || (cheer && cheer !== last.current.cheer && status === 'done')) {
    play.current += 1;
    again.current = !swap;
  }
  last.current = { status, cheer };
  const done = status === 'done';
  // Reduced motion keeps the cross-fade (MotionConfig drops the scale) and the check is simply there.
  const still = useReducedMotionConfig() === true;
  return (
    <span style={STAGE}>
      <AnimatePresence initial={false} custom={again.current}>
        <motion.span
          key={`${status}:${play.current}`}
          style={LAYER}
          custom={again.current}
          variants={GLYPH}
          initial="enter"
          animate="shown"
          exit="exit"
          transition={done ? SPRING.pop : SPRING.snappy}
        >
          <Glyph status={status} size={size} draw={play.current > 0 && !still} />
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
