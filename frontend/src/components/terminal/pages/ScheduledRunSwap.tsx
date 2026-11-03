import React from 'react';
import { AnimatePresence, motion, useIsPresent, type Transition } from 'motion/react';
import { EASE, SPRING, TRANSITION } from '../../../motion/tokens';

const FADE = { duration: 0.12, ease: EASE.out };

function Layer({ className, scale, children }: { className?: string; scale: boolean; children: React.ReactNode }) {
  // The value on its way out is not read out alongside the new one.
  const present = useIsPresent();
  const transition: Transition = scale ? SPRING.snappy : FADE;
  return (
    <motion.span
      className={['sched-swap__layer', className].filter(Boolean).join(' ')}
      initial={scale ? { scale: 0.6, opacity: 0 } : { opacity: 0 }}
      animate={scale ? { scale: 1, opacity: 1 } : { opacity: 1 }}
      exit={scale ? { scale: 0.6, opacity: 0, transition: TRANSITION.exit } : { opacity: 0, transition: FADE }}
      transition={transition}
      aria-hidden={present ? undefined : true}
    >
      {children}
    </motion.span>
  );
}

/** A glyph inside a swapping value that scales in as the value takes over (its words only fade). */
export function SwapGlyph({ children }: { children: React.ReactNode }) {
  return (
    <motion.span className="sched-swap__glyph" initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={SPRING.snappy}>
      {children}
    </motion.span>
  );
}

/**
 * A run's state in one place, the next taking over from the last when it
 * changes (Run now → running → finished): glyphs `scale` in over each other,
 * words cross-fade. Drawn settled the first time.
 */
export function RunSwap({ id, className, scale = false, children }: { id: string; className?: string; scale?: boolean; children: React.ReactNode }) {
  return (
    <span className="sched-swap">
      <AnimatePresence initial={false}>
        <Layer key={id} className={className} scale={scale}>{children}</Layer>
      </AnimatePresence>
    </span>
  );
}
