import React, { useLayoutEffect, useMemo, useRef } from 'react';
import MarkdownContent, { type MarkdownContentProps } from '../MarkdownContent';
import {
  revealTailCharsForBlock,
  updateStreamingMarkdownBlocks,
  type IncrementalStreamingMarkdownBlockState,
  type StreamingMarkdownBlock,
} from '../../lib/streamingMarkdownBlocks';

type StreamingMarkdownContentProps = Omit<MarkdownContentProps, 'text'> & {
  text: string;
};

type MarkdownBlockProps = Omit<MarkdownContentProps, 'text' | 'revealTailChars'> & {
  block: StreamingMarkdownBlock;
  first: boolean;
  last: boolean;
  revealTailChars?: number;
};

function MarkdownBlockInner({
  block,
  first,
  last,
  revealTailChars,
  ...markdownProps
}: MarkdownBlockProps) {
  return (
    <MarkdownContent
      {...markdownProps}
      text={block.text}
      revealTailChars={revealTailChars}
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
  const committedStateRef = useRef<IncrementalStreamingMarkdownBlockState | null>(null);
  const state = useMemo(
    () => updateStreamingMarkdownBlocks(committedStateRef.current, text),
    [text],
  );
  useLayoutEffect(() => {
    committedStateRef.current = state;
  }, [state]);
  const blocks = state.blocks;
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
          revealTailChars={revealTailCharsForBlock(block, text.length, revealTailChars)}
        />
      ))}
    </>
  );
}
