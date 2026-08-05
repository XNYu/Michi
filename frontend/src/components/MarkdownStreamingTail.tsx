import React, { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import {
  type InlineStreamState,
  type IncrementalTailSegmentsState,
  type TailSegment,
  updateTailSegments,
} from '../lib/inlineStreamRemend';

interface MarkdownStreamingTailValue {
  text: string;
  revealTailChars?: number;
  /** Snapshot end-state; presence enables styled-segment rendering. */
  inlineState?: InlineStreamState;
  /** Characters withheld from the snapshot display and re-fed into the tail. */
  snapshotCarry?: string;
}

const MarkdownStreamingTailContext = createContext<MarkdownStreamingTailValue>({ text: '' });

export function MarkdownStreamingTailProvider({
  children,
  text,
  revealTailChars,
  inlineState,
  snapshotCarry,
}: MarkdownStreamingTailValue & { children: React.ReactNode }) {
  return (
    <MarkdownStreamingTailContext.Provider
      value={{ text, revealTailChars, inlineState, snapshotCarry }}
    >
      {children}
    </MarkdownStreamingTailContext.Provider>
  );
}

function revealSplit(
  characters: string[],
  segmentStart: number,
  revealFrom: number,
  displayedLength: number,
): React.ReactNode {
  if (segmentStart + characters.length <= revealFrom) return characters.join('');
  const revealOffset = Math.max(0, Math.min(characters.length, revealFrom - segmentStart));
  const stableText = characters.slice(0, revealOffset).join('');
  const revealedCharacters = characters.slice(revealOffset);
  return (
    <>
      {stableText}
      {revealedCharacters.map((character, index) => {
        const globalIndex = segmentStart + revealOffset + index;
        return /\s/.test(character) ? character : (
          <span
            className="stream-token-reveal"
            data-stream-token-new
            key={`${displayedLength}-${globalIndex}`}
          >
            {character}
          </span>
        );
      })}
    </>
  );
}

function SegmentSpan({
  segment,
  children,
}: {
  segment: TailSegment;
  children: React.ReactNode;
}) {
  let node = children;
  if (segment.codeFont) {
    node = <span style={{ fontFamily: 'var(--message-code-font)' }}>{node}</span>;
  }
  if (segment.strike) node = <del>{node}</del>;
  if (segment.italic) node = <em>{node}</em>;
  if (segment.bold) node = <strong>{node}</strong>;
  return <>{node}</>;
}

function LegacyTail({ text, revealTailChars }: { text: string; revealTailChars?: number }) {
  // Keep this path byte-for-byte equivalent for the kill switch and callers
  // without snapshot inline state.
  const characters = Array.from(text);
  const revealCount = Math.min(
    characters.length,
    Math.max(0, Math.floor(revealTailChars ?? 0)),
  );
  const stableText = characters.slice(0, characters.length - revealCount).join('');
  const revealedCharacters = characters.slice(characters.length - revealCount);

  return (
    <span data-markdown-pending-tail style={{ whiteSpace: 'pre-wrap' }}>
      {stableText}
      {revealedCharacters.map((character, index) => (
        /\s/.test(character) ? character : (
          <span
            className="stream-token-reveal"
            data-stream-token-new
            key={`${text.length}-${index}`}
          >
            {character}
          </span>
        )
      ))}
    </span>
  );
}

/**
 * Tiny context consumer embedded inside the last semantic Markdown element.
 * It scans only the short pending text, never the document or snapshot block.
 */
export function MarkdownStreamingTail() {
  const { text, revealTailChars, inlineState, snapshotCarry } =
    useContext(MarkdownStreamingTailContext);
  const effectiveText = (snapshotCarry ?? '') + text;
  const committedRef = useRef<{
    inlineState: InlineStreamState;
    state: IncrementalTailSegmentsState;
  } | null>(null);
  const segmentState = useMemo(() => {
    if (!inlineState) return null;
    const previous = committedRef.current?.inlineState === inlineState
      ? committedRef.current.state
      : null;
    return updateTailSegments(previous, effectiveText, inlineState);
  }, [effectiveText, inlineState]);
  useLayoutEffect(() => {
    committedRef.current = inlineState && segmentState
      ? { inlineState, state: segmentState }
      : null;
  }, [inlineState, segmentState]);

  if (!inlineState) {
    if (!text) return null;
    return <LegacyTail text={text} revealTailChars={revealTailChars} />;
  }

  if (!effectiveText) return null;
  const segments = segmentState?.segments ?? [];
  if (segments.length === 0) return null;

  const displaySegments = segments.map((segment) => ({
    segment,
    characters: Array.from(segment.text),
  }));
  const displayedLength = displaySegments.reduce(
    (total, entry) => total + entry.characters.length,
    0,
  );
  const revealCount = Math.min(
    displayedLength,
    Math.max(0, Math.floor(revealTailChars ?? 0)),
  );
  const revealFrom = displayedLength - revealCount;
  let cursor = 0;

  return (
    <span data-markdown-pending-tail style={{ whiteSpace: 'pre-wrap' }}>
      {displaySegments.map(({ segment, characters }, index) => {
        const start = cursor;
        cursor += characters.length;
        return (
          <SegmentSpan key={index} segment={segment}>
            {revealSplit(characters, start, revealFrom, displayedLength)}
          </SegmentSpan>
        );
      })}
    </span>
  );
}
