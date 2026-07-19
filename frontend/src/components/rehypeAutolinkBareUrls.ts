/**
 * rehype plugin: autolink bare URLs and scheme URLs inside code spans.
 *
 * GFM (remark-gfm) only autolinks `http(s)://`, `www.`, and emails — and
 * never inside `<code>`. Agents frequently emit URLs in backtick-wrapped code
 * spans that end up as non-clickable plain text. This plugin fixes that:
 *
 *   - Scheme-less bare URLs (`domain.tld/path`): linked everywhere EXCEPT
 *     inside `<code>` and `<pre>` (those are likely intentional code refs).
 *   - Full `https://` URLs: linked even inside inline `<code>` spans AND
 *     `<pre>` code blocks — clickable references even in code contexts.
 *   - Text inside `<a>`, svg/math/script/style is never touched.
 *
 * Runs on the HAST after sanitize, so it operates on a clean tree.
 */

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const SKIP_TAGS = new Set(['a', 'script', 'style', 'svg', 'math']);
const SCHEME_ONLY_TAGS = new Set(['code', 'pre']);

// domain (labels + real-ish TLD) immediately followed by a required /path.
// Lookbehind blocks matches glued to a scheme (`://`), an email (`@`), a path
// segment (`/`), or another word char — so we don't re-link inside URLs that
// GFM already handled, nor inside file paths like `src/index.css`.
const BARE_URL_RE =
  /(?<![@\w./:-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(\/[^\s<>()'"]*)/gi;
// Full scheme URLs (https://...) — needed for code spans where GFM autolink
// doesn't operate.
const FULL_URL_RE = /https?:\/\/[^\s<>()'"]+/gi;
// www. URLs without a scheme — treated like scheme URLs (linked in code too).
const WWW_URL_RE = /(?<![/@\w.-])www\.[^\s<>()'"]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

function linkifyText(value: string, schemeOnly: boolean): HastNode[] | null {
  const matches: { start: number; end: number; url: string; href: string }[] = [];

  // Scheme-less bare URLs (skipped inside <code>).
  if (!schemeOnly) {
    BARE_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BARE_URL_RE.exec(value)) !== null) {
      let url = m[0];
      const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
      if (trailing) url = url.slice(0, url.length - trailing.length);
      if (!url.includes('/')) continue;
      matches.push({ start: m.index, end: m.index + url.length + trailing.length, url, href: `https://${url}` });
    }
  }

  // Full scheme URLs — always matched (needed for code spans).
  FULL_URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FULL_URL_RE.exec(value)) !== null) {
    let url = m[0];
    const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
    if (trailing) url = url.slice(0, url.length - trailing.length);
    matches.push({ start: m.index, end: m.index + url.length + trailing.length, url, href: url });
  }

  // www. URLs without scheme — always matched (like full scheme URLs).
  WWW_URL_RE.lastIndex = 0;
  while ((m = WWW_URL_RE.exec(value)) !== null) {
    let url = m[0];
    const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
    if (trailing) url = url.slice(0, url.length - trailing.length);
    matches.push({ start: m.index, end: m.index + url.length + trailing.length, url, href: `https://${url}` });
  }

  if (!matches.length) return null;

  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped: typeof matches = [];
  for (const entry of matches) {
    const prev = deduped[deduped.length - 1];
    if (prev && entry.start < prev.start + prev.url.length) continue;
    deduped.push(entry);
  }

  const out: HastNode[] = [];
  let lastIndex = 0;
  for (const { start, end, url, href } of deduped) {
    if (start > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, start) });
    }
    out.push({
      type: 'element',
      tagName: 'a',
      properties: { href },
      children: [{ type: 'text', value: url }],
    });
    const trailing = value.slice(start + url.length, end);
    if (trailing) out.push({ type: 'text', value: trailing });
    lastIndex = end;
  }

  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function walk(node: HastNode, mode: 'full' | 'scheme-only' | 'skip'): void {
  if (!Array.isArray(node.children)) return;
  const next: HastNode[] = [];

  for (const child of node.children) {
    if (child.type === 'text' && mode !== 'skip' && typeof child.value === 'string') {
      const replaced = linkifyText(child.value, mode === 'scheme-only');
      if (replaced) {
        next.push(...replaced);
        continue;
      }
      next.push(child);
      continue;
    }

    let childMode = mode;
    if (child.type === 'element' && child.tagName) {
      if (SKIP_TAGS.has(child.tagName)) childMode = 'skip';
      else if (SCHEME_ONLY_TAGS.has(child.tagName) && mode === 'full') childMode = 'scheme-only';
    }
    if (Array.isArray(child.children)) walk(child, childMode);
    next.push(child);
  }

  node.children = next;
}

/** unified/rehype plugin. */
export function rehypeAutolinkBareUrls() {
  return function transformer(tree: HastNode) {
    walk(tree, 'full');
  };
}
