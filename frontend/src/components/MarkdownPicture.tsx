import React, { useState } from 'react';
import { loadableImageUrl } from '../lib/pictureAddress';

/**
 * A Markdown picture at an https address on the internet, loaded lazily and
 * with no referrer. (Pictures that may not load never reach it: the page keeps
 * them as their alt text.) One that fails becomes a link to its address, named
 * by its alt text, or just its words inside a link of its own.
 */
export function MarkdownPicture({ src, alt, title }: { src?: unknown; alt?: unknown; title?: unknown }) {
  const href = typeof src === 'string' ? src : '';
  const loadable = loadableImageUrl(href);
  const [failed, setFailed] = useState<{ href: string; inLink: boolean } | null>(null);
  const label = typeof alt === 'string' ? alt : '';
  const words = label.trim() || href || 'Picture';
  if (!loadable || failed?.href === href) {
    // A link may not hold another one.
    if (failed?.href === href && failed.inLink) return <span data-picture-failed="">{words}</span>;
    return <a href={href || undefined} target="_blank" rel="noopener noreferrer" data-picture-failed="">{words}</a>;
  }
  return (
    <img
      src={loadable}
      alt={label}
      title={typeof title === 'string' ? title : undefined}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={(event) => setFailed({ href, inLink: event.currentTarget.closest('a') !== null })}
    />
  );
}
