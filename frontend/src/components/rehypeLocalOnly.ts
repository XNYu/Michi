/**
 * rehype plugin for Markdown from an author the reader should not have to
 * trust with their network: opening the text loads nothing, and only https
 * links remain links.
 *
 *   - `remoteMedia: false`: img becomes its alt text; picture/video/audio
 *     and other embedding elements give way to their fallback content, and
 *     nothing inside them that loads survives.
 *   - `keepImage`: with `remoteMedia: false`, an img whose src it accepts
 *     stays, with only its src, alt and title, loading lazily and sending no
 *     referrer.
 *   - `httpsLinksOnly: true`: an `a` stays a link only when its href is an
 *     https URL with a host, or an in-page `#` anchor; any other `a` becomes
 *     its text.
 *
 * Runs last, after sanitize and every autolinking pass, so it sees the tree
 * exactly as it will render, whatever Markdown or raw HTML produced it.
 */

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export interface LocalOnlyOptions {
  remoteMedia: boolean;
  httpsLinksOnly: boolean;
  /** The pictures that may still load when remote media is off: given an img's src, whether it stays. */
  keepImage?: (src: string) => boolean;
}

/** An img that may load, reduced to what it shows: no srcset or other address, no handlers. */
function keptImage(node: HastNode, options: LocalOnlyOptions): HastNode | null {
  const src = node.properties?.src;
  if (node.tagName !== 'img' || !options.keepImage || typeof src !== 'string' || !options.keepImage(src)) return null;
  const { alt, title } = node.properties ?? {};
  return {
    type: 'element',
    tagName: 'img',
    properties: {
      src: src.trim(),
      ...(typeof alt === 'string' ? { alt } : {}),
      ...(typeof title === 'string' ? { title } : {}),
      loading: 'lazy',
      decoding: 'async',
      referrerPolicy: 'no-referrer',
    },
    children: [],
  };
}

/** Elements that load what they point at, or frame something else. */
const MEDIA_TAGS = new Set(['img', 'picture', 'source', 'track', 'video', 'audio', 'iframe', 'frame', 'embed', 'object', 'image']);

function isHttpsWithHost(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

export function isLocalOnlyHref(href: unknown): boolean {
  if (typeof href !== 'string') return false;
  const trimmed = href.trim();
  return trimmed.startsWith('#') || isHttpsWithHost(trimmed);
}

function altText(node: HastNode): HastNode[] {
  const alt = node.properties?.alt;
  const text = Array.isArray(alt) ? alt.join(' ') : typeof alt === 'string' ? alt : '';
  return text ? [{ type: 'text', value: text }] : [];
}

function clean(children: HastNode[], options: LocalOnlyOptions): HastNode[] {
  const out: HastNode[] = [];
  for (const child of children) {
    if (child.type !== 'element') {
      out.push(child);
      continue;
    }
    const tag = child.tagName ?? '';
    const kids = Array.isArray(child.children) ? clean(child.children, options) : [];
    if (!options.remoteMedia && MEDIA_TAGS.has(tag)) {
      const kept = keptImage(child, options);
      out.push(...(kept ? [kept] : tag === 'img' || tag === 'image' ? altText(child) : kids));
      continue;
    }
    if (options.httpsLinksOnly && tag === 'a' && !isLocalOnlyHref(child.properties?.href)) {
      out.push(...kids);
      continue;
    }
    out.push(Array.isArray(child.children) ? { ...child, children: kids } : child);
  }
  return out;
}

export function rehypeLocalOnly(options: LocalOnlyOptions) {
  return function transform(tree: HastNode) {
    if (Array.isArray(tree.children)) tree.children = clean(tree.children, options);
  };
}
