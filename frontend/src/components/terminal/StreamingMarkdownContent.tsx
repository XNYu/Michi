import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import MarkdownContent, { type MarkdownContentProps } from '../MarkdownContent';
import {
  MarkdownStreamingTail,
  MarkdownStreamingTailProvider,
} from '../MarkdownStreamingTail';
import {
  revealTailCharsForBlock,
  updateStreamingMarkdownBlocks,
  type IncrementalStreamingMarkdownBlockState,
  type StreamingMarkdownBlock,
} from '../../lib/streamingMarkdownBlocks';
import {
  computeTailRemend,
  INITIAL_INLINE_STATE,
  type TailRemendResult,
} from '../../lib/inlineStreamRemend';
import { markdownRemendEnabled } from './markdownRemendFlag';
import { markdownReinterpretationHz } from './markdownReinterpretationFlag';

export type MarkdownReinterpretStrategy =
  | { mode: 'fixed'; hz: number }
  | { mode: 'adaptive'; maxIntervalMs: number };

type StreamingMarkdownContentProps = Omit<MarkdownContentProps, 'text'> & {
  text: string;
  /** Benchmark/testing override. Production keeps using the persisted Hz flag. */
  reinterpretStrategy?: MarkdownReinterpretStrategy;
};

type MarkdownBlockProps = Omit<MarkdownContentProps, 'text' | 'revealTailChars'> & {
  block: StreamingMarkdownBlock;
  first: boolean;
  last: boolean;
  revealTailChars?: number;
  appendStreamingTail?: boolean;
};

function MarkdownBlockInner({
  block,
  first,
  last,
  revealTailChars,
  appendStreamingTail,
  ...markdownProps
}: MarkdownBlockProps) {
  return (
    <MarkdownContent
      {...markdownProps}
      text={block.text}
      revealTailChars={revealTailChars}
      appendStreamingTail={appendStreamingTail}
      displayContents
      trimEdges={false}
      trimFirstChild={first}
      trimLastChild={last}
    />
  );
}

const MarkdownBlock = React.memo(MarkdownBlockInner, (prev, next) =>
  prev.block.text === next.block.text &&
  prev.block.index === next.block.index &&
  prev.block.start === next.block.start &&
  prev.block.end === next.block.end &&
  prev.first === next.first &&
  prev.last === next.last &&
  prev.revealTailChars === next.revealTailChars &&
  prev.appendStreamingTail === next.appendStreamingTail &&
  prev.size === next.size &&
  prev.family === next.family &&
  prev.leading === next.leading &&
  prev.className === next.className &&
  prev.style === next.style &&
  prev.features === next.features &&
  prev.highlightTerm === next.highlightTerm,
);

const ADAPTIVE_PENDING_TEXT_LIMIT = 4_096;

function isMarkdownStructureLine(line: string): boolean {
  return (
    /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line) ||
    /^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.test(line) ||
    /^ {0,3}>/.test(line) ||
    /^ {0,3}(?:`{3,}|~{3,})/.test(line) ||
    /^ {0,3}(?:\$\$|:{3,})[ \t]*$/.test(line) ||
    /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) ||
    /^ {0,3}(?:\*\s*){3,}$/.test(line) ||
    /^ {0,3}(?:_\s*){3,}$/.test(line) ||
    /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*\|?)?\s*$/.test(line) ||
    /^\s*\[\^[^\]]+\]:/.test(line) ||
    /^\s*\[[^\]]+\]:\s*\S+/.test(line) ||
    /^\s*<\/?(?:article|aside|blockquote|details|div|figure|footer|header|main|ol|pre|section|table|ul)(?:\s|>|$)/i.test(line)
  );
}

function shouldFlushAdaptiveSnapshot(snapshot: string, next: string): boolean {
  if (!next.startsWith(snapshot)) return true;
  if (next.length - snapshot.length >= ADAPTIVE_PENDING_TEXT_LIMIT) return true;

  // Include the unfinished line at the end of the previous snapshot so a
  // marker completed by newly appended text is visible to the detector.
  const unfinishedLineStart = snapshot.lastIndexOf('\n') + 1;
  const appendedWindow = next.slice(unfinishedLineStart);
  if (/\n[ \t]*\n/.test(appendedWindow)) return true;

  const completedLines = appendedWindow.split('\n').slice(0, -1);
  return completedLines.some(isMarkdownStructureLine);
}

function normalizeStrategy(
  strategy: MarkdownReinterpretStrategy | undefined,
): MarkdownReinterpretStrategy {
  if (!strategy) return { mode: 'fixed', hz: markdownReinterpretationHz() };
  if (strategy.mode === 'fixed') {
    return {
      mode: 'fixed',
      hz: Number.isFinite(strategy.hz) && strategy.hz > 0 ? strategy.hz : 0,
    };
  }
  return {
    mode: 'adaptive',
    maxIntervalMs: Number.isFinite(strategy.maxIntervalMs)
      ? Math.max(1, strategy.maxIntervalMs)
      : 1_000,
  };
}

export default function StreamingMarkdownContent({
  text,
  revealTailChars,
  reinterpretStrategy,
  ...markdownProps
}: StreamingMarkdownContentProps) {
  const reinterpretStrategyRef = useRef<MarkdownReinterpretStrategy | null>(null);
  if (reinterpretStrategyRef.current === null) {
    reinterpretStrategyRef.current = normalizeStrategy(reinterpretStrategy);
  }
  const activeStrategy = reinterpretStrategyRef.current;
  const remendEnabledRef = useRef<boolean | null>(null);
  if (remendEnabledRef.current === null) remendEnabledRef.current = markdownRemendEnabled();
  const reinterpretIntervalMs = activeStrategy.mode === 'adaptive'
    ? activeStrategy.maxIntervalMs
    : activeStrategy.hz > 0
      ? 1_000 / activeStrategy.hz
      : 0;
  const [interpretedText, setInterpretedText] = useState(text);
  const interpretedTextRef = useRef(text);
  const latestTextRef = useRef(text);
  const lastInterpretAtRef = useRef(Date.now());
  const reinterpretTimerRef = useRef<number | null>(null);
  latestTextRef.current = text;

  const appendOnly = text.startsWith(interpretedTextRef.current);
  const renderedText = reinterpretIntervalMs === 0 || !appendOnly
    ? text
    : interpretedText;

  useEffect(() => {
    if (reinterpretIntervalMs === 0) return;

    const flush = () => {
      reinterpretTimerRef.current = null;
      const next = latestTextRef.current;
      interpretedTextRef.current = next;
      lastInterpretAtRef.current = Date.now();
      setInterpretedText((current) => current === next ? current : next);
    };

    if (!text.startsWith(interpretedTextRef.current)) {
      if (reinterpretTimerRef.current !== null) window.clearTimeout(reinterpretTimerRef.current);
      flush();
      return;
    }
    if (text === interpretedTextRef.current) return;

    if (
      activeStrategy.mode === 'adaptive' &&
      shouldFlushAdaptiveSnapshot(interpretedTextRef.current, text)
    ) {
      if (reinterpretTimerRef.current !== null) window.clearTimeout(reinterpretTimerRef.current);
      flush();
      return;
    }

    if (reinterpretTimerRef.current !== null) return;

    const elapsed = Date.now() - lastInterpretAtRef.current;
    reinterpretTimerRef.current = window.setTimeout(flush, Math.max(0, reinterpretIntervalMs - elapsed));
  }, [activeStrategy.mode, text, reinterpretIntervalMs]);

  useEffect(() => () => {
    if (reinterpretTimerRef.current !== null) window.clearTimeout(reinterpretTimerRef.current);
  }, []);

  const committedStateRef = useRef<IncrementalStreamingMarkdownBlockState | null>(null);
  const state = useMemo(
    () => updateStreamingMarkdownBlocks(committedStateRef.current, renderedText),
    [renderedText],
  );
  useLayoutEffect(() => {
    committedStateRef.current = state;
  }, [state]);
  const blocks = state.blocks;
  const unfinishedBlock = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
  const tailRemend: TailRemendResult | null = useMemo(
    () => (
      remendEnabledRef.current && reinterpretIntervalMs > 0 && unfinishedBlock
        ? computeTailRemend(unfinishedBlock.text)
        : null
    ),
    [unfinishedBlock, reinterpretIntervalMs],
  );

  if (reinterpretIntervalMs === 0) {
    if (blocks.length === 0) return null;
    return (
      <>
        {blocks.map((block) => (
          <MarkdownBlock
            key={block.index}
            {...markdownProps}
            block={block}
            first={block.index === 0}
            last={block.index === blocks.length - 1}
            revealTailChars={revealTailCharsForBlock(block, renderedText.length, revealTailChars)}
          />
        ))}
      </>
    );
  }

  const stableBlocks = unfinishedBlock ? blocks.slice(0, -1) : [];
  const pendingText = text.startsWith(renderedText)
    ? text.slice(renderedText.length)
    : '';

  return (
    <div
      className="contents"
      data-markdown-reinterpret-strategy={activeStrategy.mode}
      data-markdown-reinterpret-hz={activeStrategy.mode === 'fixed' ? activeStrategy.hz : undefined}
      data-markdown-snapshot-chars={renderedText.length}
    >
      {stableBlocks.map((block) => (
        <MarkdownBlock
          key={block.index}
          {...markdownProps}
          block={block}
          first={block.index === 0}
          last={false}
        />
      ))}
      {unfinishedBlock && (
        <MarkdownStreamingTailProvider
          text={pendingText}
          revealTailChars={revealTailChars}
          inlineState={tailRemend?.endState}
          snapshotCarry={tailRemend?.carry}
        >
          <MarkdownBlock
            key={unfinishedBlock.index}
            {...markdownProps}
            appendStreamingTail
            block={tailRemend
              ? { ...unfinishedBlock, text: tailRemend.displayText }
              : unfinishedBlock}
            first={unfinishedBlock.index === 0}
            last
          />
        </MarkdownStreamingTailProvider>
      )}
      {!unfinishedBlock && (
        <MarkdownStreamingTailProvider
          text={pendingText}
          revealTailChars={revealTailChars}
          inlineState={remendEnabledRef.current ? INITIAL_INLINE_STATE : undefined}
        >
          <MarkdownStreamingTail />
        </MarkdownStreamingTailProvider>
      )}
    </div>
  );
}
