import React, { useState } from 'react';
import type { MessageAttachment } from '../../state/chatTypes';
import { useChatProjects } from '../../state/chatStore';
import { API_BASE_URL } from '../../config/env';
import { Lightbox } from './Lightbox';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function isImageAttachment(a: MessageAttachment): boolean {
  const ext = a.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

/** Build a servable image URL for an attachment. Always uses the backend
 *  /api/files route — file:// URLs are blocked by Chromium when the renderer
 *  is loaded from http:// (which is the case in both Electron dev and prod). */
function imageUrl(a: MessageAttachment, workspaceId: string | undefined): string | null {
  if (workspaceId && a.relPath) {
    const encodedPath = a.relPath.split('/').map(encodeURIComponent).join('/');
    return `${API_BASE_URL}/files/${encodeURIComponent(workspaceId)}/${encodedPath}`;
  }
  // Fallback: derive relPath from absPath if it contains .attachments/
  if (workspaceId && a.absPath) {
    const marker = '/.attachments/';
    const idx = a.absPath.indexOf(marker);
    if (idx !== -1) {
      const rel = '.attachments/' + a.absPath.slice(idx + marker.length);
      const encodedPath = rel.split('/').map(encodeURIComponent).join('/');
      return `${API_BASE_URL}/files/${encodeURIComponent(workspaceId)}/${encodedPath}`;
    }
  }
  return null;
}

interface Props {
  items: MessageAttachment[];
}

export function AttachmentPills({ items }: Props) {
  // Defensive: in test environments without ChatProvider, we gracefully degrade (no thumbnails).
  let workspaceId: string | undefined;
  try {
    const { activeProject } = useChatProjects();
    workspaceId = activeProject?.id;
  } catch {
    // No ChatProvider — render without image URL resolution
  }
  const [zoom, setZoom] = useState<{ src: string; filename: string } | null>(null);
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());

  if (items.length === 0) return null;

  const imageItems = items.filter(isImageAttachment);
  const fileItems = items.filter(a => !isImageAttachment(a));

  return (
    <div className="t-att-chips" style={{ marginBottom: 8 }}>
      {/* Image attachments: render as thumbnails */}
      {imageItems.length > 0 && (
        <div className="t-att-thumbs" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: fileItems.length > 0 ? 6 : 0 }}>
          {imageItems.map((a, i) => {
            const src = imageUrl(a, workspaceId);
            if (!src || broken.has(src)) {
              // Fallback to pill if image can't be served
              return (
                <span
                  key={`${a.absPath}-${i}`}
                  data-testid="attachment-pill"
                  className="t-att-chip"
                  title={a.absPath}
                >
                  <span style={{ fontSize: 10, opacity: 0.7 }} aria-hidden>🖼</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.name}
                  </span>
                </span>
              );
            }
            return (
              <button
                key={`${a.absPath}-${i}`}
                type="button"
                data-testid="attachment-thumb"
                className="t-att-thumb-btn"
                title={a.name}
                onClick={() => setZoom({ src, filename: a.name })}
                style={{
                  border: 'none',
                  padding: 0,
                  background: 'none',
                  cursor: 'zoom-in',
                  display: 'block',
                  overflow: 'hidden',
                  lineHeight: 0,
                }}
              >
                <img
                  src={src}
                  alt={a.name}
                  loading="lazy"
                  onError={() => setBroken(prev => new Set(prev).add(src))}
                  style={{
                    width: 160,
                    height: 160,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Non-image attachments: original pill style */}
      {fileItems.map((a, i) => (
        <span
          key={`${a.absPath}-${i}`}
          data-testid="attachment-pill"
          className="t-att-chip"
          title={a.absPath}
        >
          <span style={{ fontSize: 10, opacity: 0.7 }} aria-hidden>📄</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.name}
          </span>
        </span>
      ))}

      {/* Lightbox for zoomed image */}
      {zoom && (
        <Lightbox
          src={zoom.src}
          alt={zoom.filename}
          filename={zoom.filename}
          onClose={() => setZoom(null)}
        />
      )}
    </div>
  );
}
