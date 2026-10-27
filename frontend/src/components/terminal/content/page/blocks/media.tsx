import React, { useState } from 'react';
import { AlertCircle, ImageOff } from 'lucide-react';
import { loadableImageUrl } from '../../../../../lib/pictureAddress';
import type { BlockProps } from '../blockTypes';
import { httpsUrl, objects, str } from '../michiPageModel';
import { BlockTitle } from './text';

type PictureState = 'shown' | 'failed' | 'insecure' | 'off';

/**
 * One picture. Where the page allows pictures, one at an https address on the
 * internet loads, lazily and with no referrer. Otherwise it says why it does
 * not show, with its address.
 */
export function Picture({ url, alt, caption, load }: { url: string; alt: string; caption: string; load: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = loadableImageUrl(url);
  const https = httpsUrl(url);
  const state: PictureState = !https ? 'insecure' : !load || !src ? 'off' : failed ? 'failed' : 'shown';
  return (
    <figure className="michi-doc-picture" data-state={state}>
      <div className="michi-doc-picture__frame">
        {state === 'shown' ? (
          <a href={src!} target="_blank" rel="noopener noreferrer" className="michi-doc-picture__link" aria-label={caption || alt || 'Open picture'}>
            <img src={src!} alt={alt || caption} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
          </a>
        ) : (
          <div className="michi-doc-picture__fallback">
            {state === 'insecure' ? <AlertCircle size={14} strokeWidth={1.6} aria-hidden="true" /> : <ImageOff size={14} strokeWidth={1.6} aria-hidden="true" />}
            <span>{state === 'insecure' ? "HTTP pictures don't load" : state === 'failed' ? "Couldn't load" : 'Not loaded here'}</span>
            {https ? <a className="michi-doc-link-btn" href={https} target="_blank" rel="noopener noreferrer">Original link ↗</a>
              : <span className="michi-doc-picture__host">{url.trim()}</span>}
          </div>
        )}
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Pictures in a grid with their captions. They load only where the page allows it (native pages). */
export function GalleryBlock({ block, ctx }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.url).trim());
  return (
    <div data-michi-block="gallery">
      <BlockTitle text={str(block.title)} />
      <div className="michi-doc-gallery">
        {items.map((it, i) => (
          <Picture key={`${i}:${str(it.url)}`} url={str(it.url)} alt={str(it.alt)} caption={str(it.caption).trim()} load={ctx.loadImages === true} />
        ))}
      </div>
    </div>
  );
}
