import React from 'react';
import LegacyCodeBlock from '../../../../LegacyCodeBlock';
import MarkdownContent, { type MarkdownFeatureProfile } from '../../../../MarkdownContent';
import type { BlockProps } from '../blockTypes';
import { httpsUrl, objects, str } from '../michiPageModel';

const PROSE_CLASS =
  'prose prose-sm max-w-none wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ' +
  '[&_p]:text-(--term-mid) [&_li]:text-(--term-mid) [&_strong]:text-(--term-fg) ' +
  '[&_a]:text-(--term-accent) [&_code]:text-(--term-fg) ' +
  '[&_h1]:text-(--term-fg) [&_h2]:text-(--term-fg) [&_h3]:text-(--term-fg) [&_h4]:text-(--term-fg)';

const TONES = new Set(['info', 'warn', 'success', 'danger']);
export const toneOf = (v: unknown): string | undefined => (typeof v === 'string' && TONES.has(v) ? v : undefined);

/** Plain text split into paragraphs on blank lines or line breaks. */
export function Paragraphs({ text }: { text: string }) {
  const parts = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  return <>{parts.map((p, i) => <p key={i}>{p}</p>)}</>;
}

/** A block's own title, when it has one. */
export function BlockTitle({ text }: { text: string }) {
  return text.trim() ? <h3 className="michi-doc-block-title">{text.trim()}</h3> : null;
}

export function HeadingBlock({ block }: BlockProps) {
  const level = block.level === 1 || block.level === 3 ? block.level : 2;
  const text = str(block.text).trim();
  const Tag = level === 3 ? 'h3' : 'h2';
  return <Tag className="michi-doc-h2" data-level={level} data-michi-block="heading">{text}</Tag>;
}

/** One object for every render, so MarkdownContent's memo holds across Michi polls. */
const PROSE_STYLE: React.CSSProperties = {
  color: 'var(--term-mid)',
  fontFamily: 'var(--message-latin-font), var(--message-cjk-font)',
  fontSize: 'var(--fs-lg)',
  lineHeight: 1.68,
};

/** Michi pages are written from other apps' conversations: opening one loads nothing, and only https links stay links. */
export const MICHI_MARKDOWN_FEATURES: MarkdownFeatureProfile = { remoteMedia: false, httpsLinksOnly: true };

/** Pages that load pictures (native pages) also show Markdown pictures at https addresses on the internet. */
const PICTURE_MARKDOWN_FEATURES: MarkdownFeatureProfile = { ...MICHI_MARKDOWN_FEATURES, httpsImages: true };

/** Agent prose. Images show as their alt text, except https pictures where the page loads pictures. */
export function MarkdownBlock({ block, ctx }: BlockProps) {
  return (
    <div data-michi-block="markdown">
      <MarkdownContent text={str(block.text)} size="sm" className={PROSE_CLASS} style={PROSE_STYLE} features={ctx.loadImages === true ? PICTURE_MARKDOWN_FEATURES : MICHI_MARKDOWN_FEATURES} />
    </div>
  );
}

export function TextBlock({ block }: BlockProps) {
  return (
    <div className="michi-doc-prose" data-michi-block="text">
      <Paragraphs text={str(block.text)} />
    </div>
  );
}

/** What a callout's tone says, read out before its words: the colour alone carries nothing. */
const TONE_WORDS: Record<string, string> = { info: 'Note', warn: 'Warning', success: 'Ready', danger: 'Problem' };

const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LINE_START = /^(?:#{1,6}(?=[ \t]|$)|>|[-+*](?=[ \t]|$)|`{3,}|~{3,})/;
const ORDERED = /^(\d{1,9})([.)])(?=[ \t]|$)/;

/** One line of text with the Markdown that would make it a heading, quote, list item, fence or rule escaped. */
export function markdownLineAsText(line: string): string {
  if (THEMATIC_BREAK.test(line) || LINE_START.test(line)) return `\\${line}`;
  return line.replace(ORDERED, '$1\\$2');
}

/** Size, colour and font come from the surrounding text; the prose wrapper only draws the inline marks. */
const INLINE_STYLE: React.CSSProperties = { color: 'inherit', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit' };
const INLINE_CLASS = 'wrap-break-word [&_strong]:text-(--term-fg) [&_a]:text-(--term-accent) [&_code]:text-(--term-fg)';

/**
 * Plain text split into paragraphs on line breaks, like `Paragraphs`, with
 * each line's inline Markdown (bold, italic, code, links) drawn as Markdown
 * blocks draw it. A line keeps its own shape: "1." or "-" at its start is text.
 */
export function InlineMarkdownParagraphs({ text }: { text: string }) {
  const source = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map(markdownLineAsText).join('\n\n');
  if (!source) return null;
  return <MarkdownContent text={source} size="sm" displayContents className={INLINE_CLASS} style={INLINE_STYLE} features={MICHI_MARKDOWN_FEATURES} />;
}

/**
 * A boxed note, tinted by its tone: info a quiet note, warn the page's
 * Blockers, success ready, danger a conflict. Its title is the caption.
 */
export function CalloutBlock({ block }: BlockProps) {
  const tone = toneOf(block.tone);
  const title = str(block.title).trim();
  return (
    <div className="michi-doc-callout" data-tone={tone} data-michi-block="callout">
      {tone && <span className="sr-only">{TONE_WORDS[tone]}: </span>}
      {title && <h3 className="michi-doc-caption">{title}</h3>}
      <InlineMarkdownParagraphs text={str(block.text)} />
    </div>
  );
}

export function QuoteBlock({ block }: BlockProps) {
  const cite = str(block.cite).trim();
  return (
    <figure className="michi-doc-quote" data-michi-block="quote">
      <blockquote><Paragraphs text={str(block.text)} /></blockquote>
      {cite && <figcaption>— {cite}</figcaption>}
    </figure>
  );
}

export function DividerBlock() {
  return <hr className="michi-doc-divider" data-michi-block="divider" />;
}

export function KeyValueBlock({ block }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.key).trim() || str(it.value).trim());
  return (
    <div data-michi-block="keyvalue">
      <BlockTitle text={str(block.title)} />
      <dl className="michi-doc-kv">
        {items.map((it, i) => (
          <React.Fragment key={i}>
            <dt>{str(it.key)}</dt>
            <dd>{str(it.value)}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

export function TagsBlock({ block }: BlockProps) {
  const items = objects(block.items).filter((it) => str(it.label).trim());
  return (
    <ul className="michi-doc-tags" data-michi-block="tags">
      {items.map((it, i) => (
        <li key={i} className="michi-doc-tag" data-tone={toneOf(it.tone)}>{str(it.label)}</li>
      ))}
    </ul>
  );
}

/** The page's overall verdict: a toned badge beside a one-sentence summary, and a muted note on what it rests on. */
export function StatusBlock({ block }: BlockProps) {
  const label = str(block.label).trim();
  const summary = str(block.summary).trim();
  const note = str(block.note).trim();
  return (
    <div className="michi-doc-status" data-michi-block="status">
      {summary && <p className="michi-doc-status__summary">{summary}</p>}
      {label && (
        <span className="michi-doc-status__badge" data-tone={toneOf(block.tone)}>
          <span className="michi-doc-status__dot" aria-hidden="true" />
          {label}
        </span>
      )}
      {note && <p className="michi-doc-status__note">{note}</p>}
    </div>
  );
}

/** Code is shown, never run. */
export function CodeBlock({ block }: BlockProps) {
  const title = str(block.title).trim();
  const lang = str(block.lang).trim();
  return (
    <div data-michi-block="code">
      {(title || lang) && (
        <div className="michi-doc-block-head">
          {title ? <h3 className="michi-doc-block-title">{title}</h3> : <span />}
          {lang && <span className="michi-doc-code-lang">{lang}</span>}
        </div>
      )}
      <LegacyCodeBlock text={str(block.code)} language={lang} />
    </div>
  );
}

function siteOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** A link card with the words the agent wrote; nothing is fetched. Only https addresses link. */
export function LinkBlock({ block }: BlockProps) {
  const href = httpsUrl(block.url);
  const title = str(block.title).trim() || str(block.url);
  const description = str(block.description).trim();
  const site = str(block.site).trim() || (href ? siteOf(href) : str(block.url));
  const body = (
    <>
      <span className="michi-doc-link-card__title">{title}</span>
      {description && <span className="michi-doc-link-card__desc">{description}</span>}
      {site && <span className="michi-doc-link-card__site">{site}{href ? ' ↗' : ''}</span>}
    </>
  );
  return href ? (
    <a className="michi-doc-link-card" href={href} target="_blank" rel="noopener noreferrer" data-michi-block="link">{body}</a>
  ) : (
    <div className="michi-doc-link-card" data-michi-block="link">{body}</div>
  );
}
