import React, { useMemo, useRef, useState } from 'react';
import { Quote } from 'lucide-react';
import { parsePageSegmentSources, splitPageMarkdown, uniquePageSources, type BlockSource } from 'michi-shared';
import { HoverTip } from '../../ui/Popover';
import { MarkdownBlock } from '../content/page/blocks/text';
import { SourcesPopover, type SourceRow } from '../content/page/SourcesPopover';
import './nativeMarkdownSegments.css';

export function nativeSourceRows(sources: readonly BlockSource[], label: ((source: BlockSource) => string | undefined) | undefined, open: ((source: BlockSource) => void | boolean | Promise<void | boolean>) | undefined, onError: () => void): SourceRow[] {
  return uniquePageSources(sources).map((source, index) => ({
    key: JSON.stringify([source.nodeId, source.turnId, source.assistantId]),
    kind: 'conversation',
    label: label?.(source) || `Source ${index + 1}`,
    onOpen: () => { void Promise.resolve().then(() => open?.(source)).then(opened => { if (opened === false) onError(); }).catch(onError); },
  }));
}

/** Citation buttons are local to passages; editing, selection and dragging still belong to the original block. */
export function NativeMarkdownSegments({ blockId, text, segmentSources, sourceLabel, onOpenSource, onError, loadImages }: {
  blockId?: string;
  text: string;
  segmentSources?: unknown;
  sourceLabel?(source: BlockSource): string | undefined;
  onOpenSource?(source: BlockSource): void | boolean | Promise<void | boolean>;
  onError(): void;
  loadImages?: boolean;
}) {
  const segments = useMemo(() => splitPageMarkdown(text), [text]);
  const matched = useMemo(() => parsePageSegmentSources(text, segmentSources), [text, segmentSources]);
  const normalized = text.replace(/\r\n/g, '\n');
  const lazyContinuation = segments.some((segment, index) => (segment.kind === 'list-item' || segment.kind === 'quote') &&
    segments[index + 1]?.kind === 'paragraph' && normalized.includes(`${segment.text}\n${segments[index + 1].text}`));
  const mixedTable = segments.some((segment, index) => {
    const next = segments[index + 1];
    return next && ((segment.kind === 'paragraph' && next.kind === 'table') || (segment.kind === 'table' && next.kind === 'paragraph')) &&
      normalized.includes(`${segment.text}\n${next.text}`);
  });
  const multilineReference = /(^|\n) {0,3}\[[^\]]+\]:[^\n]*\n[ \t]+\S|(^|\n) {0,3}\[[^\]]+\]:[ \t]*(\n|$)/.test(text);
  // These constructs need one Markdown document. Their evidence remains in the parent's Sources menu.
  if (!onOpenSource || !matched?.some(segment => segment.sources.length) || lazyContinuation || mixedTable || multilineReference ||
    /(^|\n) {0,3}(?:\[\^[^\]]+\]:|\$\$)/.test(text)) {
    return <MarkdownBlock block={{ type: 'markdown', text }} ctx={{ depth: 0, loadImages }} />;
  }
  // Reference definitions belong to the whole Markdown document. Give every piece the same definitions.
  const definitionOnly = (value: string) => value.split('\n').every(line => /^ {0,3}\[[^\]]+\]:\s*\S/.test(line));
  const definitions = segments.filter(segment => segment.kind === 'paragraph' && definitionOnly(segment.text)).map(segment => segment.text).join('\n');
  let orderedNumber: number | null = null;
  let orderedDelimiter: string | null = null;
  return <div className="native-md-segments" data-michi-block="markdown">
    {segments.map(segment => {
      const numbered = segment.kind === 'list-item' && /^ {0,3}(\d+)([.)])\s/.exec(segment.text);
      orderedNumber = numbered ? (orderedNumber === null || orderedDelimiter !== numbered[2] ? Number(numbered[1]) : orderedNumber + 1) : null;
      orderedDelimiter = numbered ? numbered[2] : null;
      if (segment.kind === 'paragraph' && definitionOnly(segment.text)) return null;
      const displayText = numbered ? segment.text.replace(/^([ ]{0,3})\d+([.)])/, `$1${orderedNumber}$2`) : segment.text;
      return <MarkdownSegment key={`${segment.index}:${segment.text}`} blockId={blockId ? `${blockId}~${segment.index}` : undefined} text={segment.text} renderText={definitions ? `${displayText}\n\n${definitions}` : displayText} index={segment.index} kind={segment.kind}
      // An explicit empty list means this passage has no cited source; the parent retains its whole-block Sources menu.
      rows={nativeSourceRows(matched[segment.index].sources, sourceLabel, onOpenSource, onError)} loadImages={loadImages} />;
    })}
  </div>;
}

function MarkdownSegment({ blockId, text, renderText, index, kind, rows, loadImages }: {
  blockId?: string; text: string; renderText: string; index: number; kind: string; rows: SourceRow[]; loadImages?: boolean;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const title = text.replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6})\s+/, '').slice(0, 80) || `Item ${index + 1}`;
  return <div className="native-md-segment" data-block-id={blockId} data-native-segment-index={index} data-native-segment-kind={kind} data-sources-open={open || undefined}>
    <MarkdownBlock block={{ type: 'markdown', text: renderText }} ctx={{ depth: 0, loadImages }} />
    {rows.length > 0 && <HoverTip label="Sources" delayMs={250}><button ref={button} type="button" className="native-md-segment__sources"
      aria-label={`Sources for item ${index + 1}`} aria-haspopup="dialog" aria-expanded={open} onClick={event => { event.stopPropagation(); setOpen(value => !value); }}>
      <Quote size={14} aria-hidden="true" />
    </button></HoverTip>}
    {open && button.current && <SourcesPopover anchor={button.current} label={title} count={rows.length} rows={rows} onOpenThread={() => {}} onClose={() => setOpen(false)} />}
  </div>;
}
