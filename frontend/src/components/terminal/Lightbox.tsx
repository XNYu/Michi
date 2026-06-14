import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

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
 * dismiss. Fades in on mount.
 */
export function Lightbox({ src, alt, filename, mimeType, size, caption, onClose }: LightboxProps) {
  const [visible, setVisible] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    // Flip on after mount so the opacity transition runs (fade-in).
    const raf = requestAnimationFrame(() => setVisible(true));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

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
    <div
      role="dialog"
      aria-modal="true"
      aria-label={filename || 'Image viewer'}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.88)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        cursor: 'zoom-out',
        opacity: visible ? 1 : 0,
        transition: 'opacity 140ms ease-out',
      }}
    >
      <img
        src={src}
        alt={alt ?? ''}
        onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: '92vw',
          maxHeight: '82vh',
          objectFit: 'contain',
          borderRadius: 8,
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
          <div style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-all' }}>{filename}</div>
        )}
        {meta.length > 0 && (
          <div style={{ fontSize: 12, opacity: 0.55 }}>{meta.join('  ·  ')}</div>
        )}
        {caption && (
          <div style={{ fontSize: 12, opacity: 0.8, fontStyle: 'italic', marginTop: 2 }}>{caption}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
