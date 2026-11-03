import React, { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { animate, motion, MotionGlobalConfig, type Transition } from 'motion/react';
import { DUR, TRANSITION } from '../../motion/tokens';
import { useOverlayFocus } from '../ui/useOverlayFocus';

const FADE_IN: Transition = { duration: DUR.soft, ease: 'easeOut' };

/**
 * Callers unmount the viewer from `onClose`, so it fades out as a copy: a
 * static snapshot that is no dialog and takes no clicks, keys or focus, and
 * leaves the next open (the same image tapped again, too) free to mount at once.
 */
function fadeOutCopy(viewer: HTMLElement, opacity: string) {
  const copy = viewer.cloneNode(true) as HTMLElement;
  copy.removeAttribute('role');
  copy.removeAttribute('aria-modal');
  copy.removeAttribute('tabindex');
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('inert', '');
  copy.style.pointerEvents = 'none';
  copy.style.opacity = opacity;
  document.body.appendChild(copy);
  const remove = () => copy.remove();
  // A hidden window never finishes the fade; the copy goes anyway.
  window.setTimeout(remove, DUR.exit * 1000 + 250);
  animate(copy, { opacity: 0 }, TRANSITION.exit).then(remove, remove);
}

function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface LightboxProps {
  src: string;
  /** Accessible name for the zoomed image (caption, if any). */
  alt?: string;
  /** Info-bar fields. */
  filename?: string;
  mimeType?: string;
  size?: number;
  caption?: string;
  onClose: () => void;
}

/**
 * Full-screen image viewer: dark backdrop, large centered image, and an info
 * bar (filename · dimensions · size · type, plus caption). Closes on backdrop
 * click or Escape; clicks on the image/info-bar are swallowed so they don't
 * dismiss. Fades in on mount; on unmount a static copy fades out over the
 * page (see fadeOutCopy) while focus returns to the opener at once.
 */
export function Lightbox({ src, alt, filename, mimeType, size, caption, onClose }: LightboxProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  useOverlayFocus({ open: true, panelRef, restore: 'always' });
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useLayoutEffect(() => {
    const viewer = panelRef.current;
    return () => {
      if (!viewer || MotionGlobalConfig.skipAnimations) return;
      // Read while it is still on screen, mid fade-in included.
      const opacity = getComputedStyle(viewer).opacity;
      // StrictMode's rehearsal unmount keeps the viewer in place: only a real
      // close (the viewer gone by now) fades.
      queueMicrotask(() => { if (!viewer.isConnected) fadeOutCopy(viewer, opacity); });
    };
  }, []);

  const meta = [
    dims ? `${dims.w}×${dims.h}` : null,
    formatBytes(size) || null,
    mimeType || null,
  ].filter(Boolean);

  // Portal to <body>: a pane ancestor sets `filter: brightness(...)` (focus
  // dim), which makes `position: fixed` resolve against the PANE, not the
  // viewport — trapping the overlay inside the pane. Rendering into body
  // escapes that containing block so the overlay covers the whole app.
  return createPortal(
    <motion.div
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={filename || 'Image viewer'}
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: FADE_IN }}
      style={{
        position: 'fixed',
        inset: 0,
        // Media viewer, not a dialog card: keeps its near-black backdrop (the
        // standard for judging images) but joins the managed z ladder.
        zIndex: 'var(--z-lightbox)',
        background: 'rgba(0,0,0,0.88)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        cursor: 'zoom-out',
      }}
    >
      <button
        type="button"
        aria-label="Close image viewer"
        onClick={(event) => { event.stopPropagation(); onClose(); }}
        className="ui-overlay-close"
        style={{ position: 'absolute', top: 16, right: 16, color: 'rgba(255,255,255,0.92)' }}
      >×</button>
      <img
        src={src}
        alt={alt ?? ''}
        onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          maxHeight: '82vh',
          objectFit: 'contain',
          borderRadius: 'var(--ui-radius)',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          cursor: 'default',
        }}
      />
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          color: 'rgba(255,255,255,0.92)',
          textAlign: 'center',
          cursor: 'default',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {filename && (
          <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, wordBreak: 'break-all' }}>{filename}</div>
        )}
        {meta.length > 0 && (
          <div style={{ fontSize: 'var(--fs-md)', opacity: 0.55 }}>{meta.join('  ·  ')}</div>
        )}
        {caption && (
          <div style={{ fontSize: 'var(--fs-md)', opacity: 0.8, fontStyle: 'italic', marginTop: 2 }}>{caption}</div>
        )}
      </div>
    </motion.div>,
    document.body,
  );
}
