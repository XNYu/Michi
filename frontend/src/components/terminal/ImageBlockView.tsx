import React, { useState } from 'react';
import type { AssistantBlock } from '../../state/chatTypes';
import { API_BASE_URL } from '../../config/env';
import { Lightbox } from './Lightbox';

type ImageBlock = Extract<AssistantBlock, { kind: 'image' }>;
type Zoom = { src: string; filename: string; mimeType: string; size: number; caption?: string };

export function ImageBlockView({ blocks }: { blocks: readonly AssistantBlock[] }) {
  const [zoom, setZoom] = useState<Zoom | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const images = blocks.filter((b): b is ImageBlock => b.kind === 'image');
  if (images.length === 0) return null;
  return (
    <div className="t-image-block" style={{ margin: '8px 0' }}>
      {images.map((b) => {
        // Build off API_BASE_URL (absolute http://host:3000/api in dev, '/api'
        // in the packaged app) — NOT a hardcoded relative '/api/...', which in
        // dev resolves to the vite origin (:3001) instead of the backend.
        const src = `${API_BASE_URL}/files/${encodeURIComponent(b.workspaceId)}/${b.path.split('/').map(encodeURIComponent).join('/')}`;
        if (broken.has(src)) {
          return (
            <figure key={b.id} style={{ margin: 0 }}>
              <div style={{ fontSize: 12, opacity: 0.6, fontStyle: 'italic' }}>image unavailable</div>
              {b.caption && <figcaption style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{b.caption}</figcaption>}
            </figure>
          );
        }
        return (
          <figure key={b.id} style={{ margin: 0 }}>
            <button
              type="button"
              aria-label={b.caption || 'Open image'}
              onClick={() =>
                setZoom({
                  src,
                  filename: b.path.split('/').pop() || b.path,
                  mimeType: b.mimeType,
                  size: b.size,
                  caption: b.caption,
                })
              }
              style={{ border: 'none', padding: 0, background: 'none', cursor: 'zoom-in', display: 'block' }}
            >
              <img
                src={src}
                alt={b.caption ?? ''}
                loading="lazy"
                onError={() => setBroken((prev) => new Set(prev).add(src))}
                style={{ maxWidth: '100%', borderRadius: 6, display: 'block' }}
              />
            </button>
            {b.caption && <figcaption style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{b.caption}</figcaption>}
          </figure>
        );
      })}
      {zoom && (
        <Lightbox
          src={zoom.src}
          alt={zoom.caption ?? ''}
          filename={zoom.filename}
          mimeType={zoom.mimeType}
          size={zoom.size}
          caption={zoom.caption}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}
