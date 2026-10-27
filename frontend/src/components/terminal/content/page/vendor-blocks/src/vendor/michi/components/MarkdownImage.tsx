import {createContext, useContext, useLayoutEffect, useRef, useState, type RefObject} from 'react';
// Michi: preserve native image loading and private-network policy.
import {loadableImageUrl} from '../../../../../../../../../lib/pictureAddress';
import {L} from '../../../../shared/i18n';

// agent-desk: host-added, not Michi source. Only https images load (the CSP allows no http:); anything else, or a failed load, degrades to alt text.
const WEB = /^https?:\/\//i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** The address an image may load from under this rule (https only), or null. Database gallery covers follow it too. */
export const httpsImage = loadableImageUrl;
export const PageImagesContext = createContext(false);
export const usePageImage = (src: unknown) => { const allowed = useContext(PageImagesContext); return allowed ? httpsImage(src) : null; };

export default function MarkdownImage({src, alt, title}: {src?: string; alt?: string; title?: string}) {
  const url = typeof src === 'string' ? src.trim() : '';
  const allowed = useContext(PageImagesContext);
  const [failed, setFailed] = useState(false);
  // An image inside [![..](..)](..) already has a destination; a nested <a> would be invalid, so it falls back to text only.
  const [nested, setNested] = useState<boolean | null>(null);
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { setNested(!!ref.current?.parentElement?.closest('a')); }, []);
  if (allowed && httpsImage(url) && !failed) return <img ref={ref as RefObject<HTMLImageElement>} src={url} alt={alt} title={title} referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
  const label = alt?.trim() || L('图片', 'Image');
  // Web and relative addresses are safe to link; javascript:, data: and the like stay plain text.
  const linkable = WEB.test(url) || (url !== '' && !SCHEME.test(url));
  return linkable && nested === false ? <a href={url} title={title} target="_blank" rel="noopener noreferrer">{label}</a> : <span ref={ref} title={title}>{label}</span>;
}
