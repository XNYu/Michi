/**
 * rehype plugin: conservatively autolink scheme-less bare URLs.
 *
 * GFM (remark-gfm) only autolinks `http(s)://`, `www.`, and emails. Agents
 * frequently emit scheme-less hostnames in table "URL/Link" columns
 * (e.g. `docs.example.com/ec2/home`), which then render as plain,
 * non-clickable text. This plugin links those, but conservatively:
 *
 *   - The match MUST include a `/path` segment. This is what keeps
 *     `package.json`, `e.g.`, `v1.2.3`, and bare `github.com` from becoming
 *     links — only `domain.tld/...` shaped text is linkified.
 *   - Text inside `<a>`, `<code>`, `<pre>` (and svg/math/script/style) is
 *     never touched, so existing links and code samples are left alone.
 *   - Only `https://` links are produced (trusted scheme).
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

const SKIP_TAGS = new Set(['a', 'code', 'pre', 'script', 'style', 'svg', 'math']);

// domain (labels + real-ish TLD) immediately followed by a required /path.
// Lookbehind blocks matches glued to a scheme (`://`), an email (`@`), a path
// segment (`/`), or another word char — so we don't re-link inside URLs that
// GFM already handled, nor inside file paths like `src/index.css`.
const BARE_URL_RE =
  /(?<![@\w./:-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(\/[^\s<>()'"]*)/gi;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

function linkifyText(value: string): HastNode[] | null {
  BARE_URL_RE.lastIndex = 0;
  const out: HastNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BARE_URL_RE.exec(value)) !== null) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;

    // Trailing sentence punctuation ("see foo.com/bar.") stays as plain text.
    let url = match[0];
    const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
    if (trailing) url = url.slice(0, url.length - trailing.length);

    // Path may have been entirely punctuation that got trimmed; require a slash.
    if (!url.includes('/')) continue;

    if (matchStart > lastIndex) {
      out.push({ type: 'text', value: value.slice(lastIndex, matchStart) });
    }
    out.push({
      type: 'element',
      tagName: 'a',
      properties: { href: `https://${url}` },
      children: [{ type: 'text', value: url }],
    });
    if (trailing) out.push({ type: 'text', value: trailing });
    lastIndex = matchEnd;
  }

  if (!out.length) return null;
  if (lastIndex < value.length) {
    out.push({ type: 'text', value: value.slice(lastIndex) });
  }
  return out;
}

function walk(node: HastNode, skip: boolean): void {
  if (!Array.isArray(node.children)) return;
  const next: HastNode[] = [];

  for (const child of node.children) {
    if (child.type === 'text' && !skip && typeof child.value === 'string') {
      const replaced = linkifyText(child.value);
      if (replaced) {
        next.push(...replaced);
        continue;
      }
      next.push(child);
      continue;
    }

    const childSkip =
      skip ||
      (child.type === 'element' && !!child.tagName && SKIP_TAGS.has(child.tagName));
    if (Array.isArray(child.children)) walk(child, childSkip);
    next.push(child);
  }

  node.children = next;
}

/** unified/rehype plugin. */
export function rehypeAutolinkBareUrls() {
  return function transformer(tree: HastNode) {
    walk(tree, false);
  };
}
