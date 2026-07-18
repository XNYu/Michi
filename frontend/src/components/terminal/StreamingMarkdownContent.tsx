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
import { markdownReinterpretationHz } from './markdownReinterpretationFlag';

type StreamingMarkdownContentProps = Omit<MarkdownContentProps, 'text'> & {
  text: string;
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
  prev.highlightTerm === next.highlightTerm,
);

export default function StreamingMarkdownContent({
  text,
  revealTailChars,
  ...markdownProps
}: StreamingMarkdownContentProps) {
  const reinterpretHzRef = useRef<number | null>(null);
  if (reinterpretHzRef.current === null) reinterpretHzRef.current = markdownReinterpretationHz();
  const reinterpretIntervalMs = reinterpretHzRef.current > 0
    ? 1_000 / reinterpretHzRef.current
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
    if (text === interpretedTextRef.current || reinterpretTimerRef.current !== null) return;

    const elapsed = Date.now() - lastInterpretAtRef.current;
    reinterpretTimerRef.current = window.setTimeout(flush, Math.max(0, reinterpretIntervalMs - elapsed));
  }, [text, reinterpretIntervalMs]);

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

  const unfinishedBlock = blocks[blocks.length - 1];
  const stableBlocks = unfinishedBlock ? blocks.slice(0, -1) : [];
  const pendingText = text.startsWith(renderedText)
    ? text.slice(renderedText.length)
    : '';

  return (
    <div
      className="contents"
      data-markdown-reinterpret-hz={reinterpretHzRef.current}
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
        <MarkdownStreamingTailProvider text={pendingText}>
          <MarkdownBlock
            key={unfinishedBlock.index}
            {...markdownProps}
            appendStreamingTail
            block={unfinishedBlock}
            first={unfinishedBlock.index === 0}
            last
          />
        </MarkdownStreamingTailProvider>
      )}
      {!unfinishedBlock && (
        <MarkdownStreamingTailProvider text={pendingText}>
          <MarkdownStreamingTail />
        </MarkdownStreamingTailProvider>
      )}
    </div>
  );
}
