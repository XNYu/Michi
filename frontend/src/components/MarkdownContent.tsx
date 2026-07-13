import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { rehypeAutolinkBareUrls } from './rehypeAutolinkBareUrls';
import MarkdownRendererAdapter from './MarkdownRendererAdapter';
import LegacyCodeBlock, { languageFromClassName } from './LegacyCodeBlock';
import { hasCjkText, performanceNowMs, rendererStreamProbeEnabled, writeRendererStreamProbe } from '../lib/streamProbe';
import { countRender } from '../services/renderCounters';

export interface MarkdownContentProps {
  text: string;
  /** Prose size. Defaults to prose-sm. */
  size?: 'xs' | 'sm' | 'base' | 'lg';
  /** Tailwind font-family class override. */
  family?: string;
  /** Tailwind leading class override. */
  leading?: string;
  /** Extra class names appended. */
  className?: string;
  /** Inline styles applied to the prose wrapper (useful for overriding --tw-prose-* vars). */
  style?: React.CSSProperties;
  /** When set, matching substrings are wrapped in <mark> for search highlighting. */
  highlightTerm?: string | null;
  /** When set, wraps newly rendered text in spans that fade from faint to normal. */
  revealTailChars?: number;
  /** Render the prose wrapper without its own layout box. */
  displayContents?: boolean;
  /** Trim first/last child margins. Defaults to true, matching legacy behavior. */
  trimEdges?: boolean;
  /** Override first child top-margin trimming. Defaults to trimEdges. */
  trimFirstChild?: boolean;
  /** Override last child bottom-margin trimming. Defaults to trimEdges. */
  trimLastChild?: boolean;
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'br'],
};

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

interface StreamingRevealState {
  previousText: string;
}

const STREAM_REVEAL_SKIP_TAGS = new Set(['code', 'pre', 'svg', 'math', 'annotation']);
const WHITESPACE_RE = /^\s+$/;

function allText(node: HastNode): string {
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : '';
  if (!Array.isArray(node.children)) return '';
  return node.children.map(allText).join('');
}

function dropEmptyCodeBlocks(children: HastNode[]): HastNode[] {
  return children.flatMap((child) => {
    if (child.type === 'element' && child.tagName === 'pre' && !allText(child).trim()) {
      return [];
    }
    if (Array.isArray(child.children)) {
      return [{ ...child, children: dropEmptyCodeBlocks(child.children) }];
    }
    return [child];
  });
}

function renderedText(node: HastNode, skip = false): string {
  if (skip) return '';
  if (node.type === 'text') return typeof node.value === 'string' ? node.value : '';
  if (!Array.isArray(node.children)) return '';
  const shouldSkip = node.type === 'element' && !!node.tagName && STREAM_REVEAL_SKIP_TAGS.has(node.tagName);
  return node.children.map((child) => renderedText(child, shouldSkip)).join('');
}

function domRevealText(node: Node, skip = false): string {
  if (skip) return '';
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType !== 1) return '';

  const element = node as Element;
  const shouldSkip = STREAM_REVEAL_SKIP_TAGS.has(element.localName);
  return Array.from(element.childNodes).map((child) => domRevealText(child, shouldSkip)).join('');
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function createStreamingRevealPlugin(state: StreamingRevealState) {
  return function streamingRevealPlugin() {
    return function transform(tree: HastNode) {
      if (Array.isArray(tree.children)) {
        tree.children = dropEmptyCodeBlocks(tree.children);
      }

      const currentText = renderedText(tree);
      const previousLength = commonPrefixLength(currentText, state.previousText);
      let cursor = 0;

      const transformChildren = (children: HastNode[], skip = false): HastNode[] => {
        const next: HastNode[] = [];
        for (const child of children) {
          if (child.type === 'text' && !skip) {
            const value = child.value ?? '';
            if (!value) {
              next.push(child);
              continue;
            }

            let stable = '';
            for (const char of Array.from(value)) {
              const start = cursor;
              cursor += char.length;
              const alreadyVisible = start < previousLength;
              if (WHITESPACE_RE.test(char)) {
                stable += char;
                continue;
              }
              if (stable) {
                next.push({ ...child, value: stable });
                stable = '';
              }
              next.push({
                type: 'element',
                tagName: 'span',
                properties: {
                  className: ['stream-token-reveal'],
                  ...(alreadyVisible ? { style: '--stream-token-reveal-duration:0ms' } : { 'data-stream-token-new': true }),
                },
                children: [{ type: 'text', value: char }],
              });
            }
            if (stable) next.push({ ...child, value: stable });
            continue;
          }

          if (Array.isArray(child.children)) {
            const childSkip = skip || (
              child.type === 'element' &&
              !!child.tagName &&
              STREAM_REVEAL_SKIP_TAGS.has(child.tagName)
            );
            next.push({ ...child, children: transformChildren(child.children, childSkip) });
          } else {
            next.push(child);
          }
        }
        return next;
      };

      if (Array.isArray(tree.children)) {
        tree.children = transformChildren(tree.children);
      }
    };
  };
}

/** Split text on the search term and wrap matches in <mark> (case-insensitive). */
function HighlightText({ children, term }: { children: string; term: string }) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = children.split(new RegExp(`(${escaped})`, 'gi'));
  if (parts.length === 1) return <>{children}</>;
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === term.toLowerCase() ? (
          <mark key={i} className="bg-yellow-300 text-black rounded-sm px-0.5">{part}</mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Recursively walk React children, wrapping string leaves with HighlightText. */
function highlightChildren(children: React.ReactNode, term: string): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') return <HighlightText term={term}>{child}</HighlightText>;
    if (React.isValidElement(child) && child.props.children) {
      return React.cloneElement(child as React.ReactElement<any>, {}, highlightChildren(child.props.children, term));
    }
    return child;
  });
}

function reactNodeText(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(reactNodeText).join('');
  if (React.isValidElement(children)) return reactNodeText(children.props.children);
  return '';
}

function MarkdownContentInner({
  text,
  size = 'sm',
  family,
  leading,
  className,
  style,
  highlightTerm,
  revealTailChars,
  displayContents = false,
  trimEdges = true,
  trimFirstChild,
  trimLastChild,
}: MarkdownContentProps) {
  countRender('MarkdownContent', `${text.length}:${text.slice(0, 24)}`, {
    textChars: text.length,
    revealTailChars: revealTailChars ?? 0,
  });
  const probeEnabled = rendererStreamProbeEnabled();
  const renderStartedAt = probeEnabled ? performanceNowMs() : 0;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const revealStateRef = useRef<StreamingRevealState>({ previousText: '' });
  const probeIdRef = useRef<string | null>(null);
  const lastCommitAtRef = useRef<number | null>(null);
  const lastTextCharsRef = useRef(text.length);
  const [rehypeKatex, setRehypeKatex] = useState<null | ((...args: unknown[]) => unknown)>(null);
  useEffect(() => {
    if (rehypeKatex === null && hasMath(text)) {
      void Promise.all([
        import('rehype-katex'),
        import('katex/dist/katex.min.css'),
      ]).then(([mod]) => {
        setRehypeKatex(() => mod.default);
      });
    }
  }, [text, rehypeKatex]);
  const proseSize =
    size === 'xs' ? 'prose-xs' :
    size === 'sm' ? 'prose-sm' :
    size === 'lg' ? 'prose-lg' : 'prose-base';
  const shouldTrimFirstChild = trimFirstChild ?? trimEdges;
  const shouldTrimLastChild = trimLastChild ?? trimEdges;
  const cls = [
    'prose',
    proseSize,
    family || '',
    leading || '',
    'max-w-none wrap-break-word',
    shouldTrimFirstChild ? '[&>*:first-child]:mt-0' : '',
    shouldTrimLastChild ? '[&>*:last-child]:mb-0' : '',
    displayContents ? 'contents' : '',
    className || '',
  ].filter(Boolean).join(' ');
  const ht = highlightTerm?.trim() || null;
  const revealEnabled = !!(revealTailChars && revealTailChars > 0);
  const revealPlugin = useMemo(
    () => revealEnabled ? createStreamingRevealPlugin(revealStateRef.current) : null,
    [revealEnabled],
  );
  const rehypePlugins = useMemo(() => {
    // autolink runs after sanitize (clean tree) but before the reveal plugin,
    // which splits text into per-char spans and would otherwise hide the URL.
    const plugins: any[] = [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeAutolinkBareUrls];
    if (revealPlugin) plugins.push(revealPlugin);
    return plugins;
  }, [rehypeKatex, revealPlugin]);
  // External links open in a new context (system browser in Electron via
  // setWindowOpenHandler; a new tab in a plain browser) instead of replacing
  // the app. Internal/relative/mailto/hash links keep default behavior.
  const anchorComponent = useMemo(() => {
    return function MarkdownAnchor({ href, children, node: _node, ...props }: any) {
      const url = typeof href === 'string' ? href : '';
      const external = /^https?:\/\//i.test(url);
      const content = ht ? highlightChildren(children, ht) : children;
      return (
        <a
          {...props}
          href={href}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {content}
        </a>
      );
    };
  }, [ht]);
  const hlComponents = useMemo(() => {
    if (!ht) return {};
    const wrap = (Tag: string) =>
      ({ children, ...props }: any) => React.createElement(Tag, props, highlightChildren(children, ht));
    // `a` is handled by anchorComponent (which also applies highlighting).
    return { p: wrap('p'), li: wrap('li'), td: wrap('td'), th: wrap('th'), h1: wrap('h1'), h2: wrap('h2'), h3: wrap('h3'), h4: wrap('h4'), h5: wrap('h5'), h6: wrap('h6'), strong: wrap('strong'), em: wrap('em'), blockquote: wrap('blockquote') };
  }, [ht]);

  useLayoutEffect(() => {
    if (probeEnabled) {
      if (probeIdRef.current === null) {
        probeIdRef.current = `markdown-${Math.random().toString(36).slice(2, 8)}`;
      }
      const now = performanceNowMs();
      const lastCommitAt = lastCommitAtRef.current;
      const previousTextChars = lastTextCharsRef.current;
      writeRendererStreamProbe({
        phase: 'markdown_commit',
        subsystem: 'markdown',
        probeId: probeIdRef.current,
        renderer: 'react-markdown',
        revealEnabled,
        revealTailChars: revealTailChars ?? 0,
        cjk: hasCjkText(text),
        textChars: text.length,
        deltaChars: text.length - previousTextChars,
        dtMs: lastCommitAt === null ? 0 : Math.round(now - lastCommitAt),
        renderToCommitMs: Math.round((now - renderStartedAt) * 10) / 10,
      });
      lastCommitAtRef.current = now;
      lastTextCharsRef.current = text.length;
    }
    revealStateRef.current.previousText = revealEnabled && rootRef.current
      ? domRevealText(rootRef.current)
      : '';
  }, [text, revealEnabled, revealTailChars, renderStartedAt, probeEnabled]);

  return (
    <div ref={rootRef} className={cls} style={style}>
      <MarkdownRendererAdapter
        text={text}
        legacyRemarkPlugins={remarkPlugins}
        legacyRehypePlugins={rehypePlugins}
        legacyComponents={{
          ...hlComponents,
          a: anchorComponent,
          pre({ children, node: _node, ...props }: any) {
            if (React.Children.count(children) === 1) return <>{children}</>;
            return <pre {...props}>{children}</pre>;
          },
          code({ className: codeClass, children, node: _node, ...props }) {
            const codeText = reactNodeText(children);
            const language = languageFromClassName(codeClass);
            const isBlock = !!language || codeText.includes('\n');
            if (isBlock) {
              return (
                <LegacyCodeBlock
                  className={codeClass}
                  deferHighlight={revealEnabled}
                  language={language}
                  text={codeText}
                  data-michi-code-block
                />
              );
            }
            return (
              <code className={codeClass} {...props}>
                {children}
              </code>
            );
          },
        }}
      />
    </div>
  );
}

const MarkdownContent = React.memo(MarkdownContentInner, (prev, next) =>
  prev.text === next.text &&
  prev.size === next.size &&
  prev.family === next.family &&
  prev.leading === next.leading &&
  prev.className === next.className &&
  prev.style === next.style &&
  prev.highlightTerm === next.highlightTerm &&
  prev.revealTailChars === next.revealTailChars &&
  prev.displayContents === next.displayContents &&
  prev.trimEdges === next.trimEdges &&
  prev.trimFirstChild === next.trimFirstChild &&
  prev.trimLastChild === next.trimLastChild,
);

export default MarkdownContent;
