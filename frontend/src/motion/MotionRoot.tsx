import React from 'react';
import { MotionConfig } from 'motion/react';
import { usePrefs } from '../state/prefs';
import { TRANSITION } from './tokens';

/**
 * App-wide motion settings. `reducedMotion="user"` only reads the OS setting,
 * so the in-app Reduce motion preference maps to "always". Either way motion
 * keeps opacity and colour animations and drops transforms and layout moves.
 */
export function MotionRoot({ children }: { children: React.ReactNode }) {
  const { prefs } = usePrefs();
  return (
    <MotionConfig reducedMotion={prefs.reduceMotion ? 'always' : 'user'} transition={TRANSITION.enter}>
      {children}
    </MotionConfig>
  );
}
