import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from 'motion/react';
import type { DigestState } from '../../state/digest';
import { EASE } from '../../motion/tokens';

export default function DigestGenerationStatus({ digest }: { digest: DigestState }) {
  const [now, setNow] = useState(Date.now);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const streaming = digest.status === 'streaming';
  const generation = digest.generation;

  useEffect(() => {
    if (!streaming) return;
    setNow(Date.now());
    followRef.current = true;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [streaming, generation?.startedAt]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [generation?.thought]);

  if (digest.status === 'error') {
    return <div role="alert" style={{ color: 'var(--term-danger)', padding: '12px 0', overflowWrap: 'anywhere' }}>
      {digest.error || 'Digest generation failed.'}
    </div>;
  }

  const elapsed = Math.max(0, Math.floor((now - (generation?.startedAt ?? now)) / 1000));
  const duration = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

  // Finished, the progress folds away (120ms) as the digest takes its place, rather than vanishing.
  return (
    <AnimatePresence initial={false}>
      {streaming && (
        <Leaving key="generation">
          <section aria-label="Digest generation" style={{ minWidth: 0, padding: '12px 0', fontSize: 'var(--fs-md)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minHeight: 20 }}>
              <span role="status" className="term-shimmer" style={{ color: 'var(--term-digest)', overflowWrap: 'anywhere', minWidth: 0 }}>
                {generation?.activity || 'Generating digest...'}
              </span>
              <span aria-hidden style={{ marginLeft: 'auto', flexShrink: 0, color: 'var(--term-muted)', fontVariantNumeric: 'tabular-nums' }}>
                {duration}
              </span>
            </div>
            {generation?.thought && (
              <div
                ref={scrollRef}
                role="region"
                aria-label="Digest thinking"
                tabIndex={0}
                className="term-scrollbar"
                onScroll={(event) => {
                  const el = event.currentTarget;
                  followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
                }}
                style={{
                  maxHeight: 200,
                  overflowY: 'auto',
                  overflowWrap: 'anywhere',
                  whiteSpace: 'pre-wrap',
                  color: 'var(--term-muted)',
                  lineHeight: 1.65,
                  borderLeft: '2px solid var(--term-line)',
                  paddingLeft: 12,
                  marginTop: 10,
                }}
              >
                {generation.thought}
              </div>
            )}
          </section>
        </Leaving>
      )}
    </AnimatePresence>
  );
}

const LEAVE = { duration: 0.12, ease: EASE.out };

/** The progress on its way out: out of the accessibility tree, inert, folding with its height under full motion. */
function Leaving({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  const still = useReducedMotionConfig() === true;
  return (
    <motion.div exit={still ? { opacity: 0, transition: LEAVE } : { opacity: 0, height: 0, overflow: 'hidden', transition: LEAVE }}
      aria-hidden={present ? undefined : true} inert={!present}>
      {children}
    </motion.div>
  );
}
