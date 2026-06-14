import React, { useMemo } from 'react';
import MarkdownContent, { type MarkdownContentProps } from '../MarkdownContent';
import {
  revealTailCharsForBlock,
  splitStreamingMarkdownBlocks,
  type StreamingMarkdownBlock,
} from '../../lib/streamingMarkdownBlocks';

type StreamingMarkdownContentProps = Omit<MarkdownContentProps, 'text'> & {
  text: string;
};

type MarkdownBlockProps = Omit<MarkdownContentProps, 'text' | 'revealTailChars'> & {
  block: StreamingMarkdownBlock;
  blockCount: number;
  revealTailChars?: number;
};

function MarkdownBlockInner({
  block,
  blockCount,
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
      trimFirstChild={block.index === 0}
      trimLastChild={block.index === blockCount - 1}
    />
  );
}

const MarkdownBlock = React.memo(MarkdownBlockInner, (prev, next) =>
  prev.block.text === next.block.text &&
  prev.block.index === next.block.index &&
  prev.block.start === next.block.start &&
  prev.block.end === next.block.end &&
  prev.blockCount === next.blockCount &&
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
  const blocks = useMemo(() => splitStreamingMarkdownBlocks(text), [text]);
  if (blocks.length === 0) return null;

  return (
    <>
      {blocks.map((block) => (
        <MarkdownBlock
          key={block.index}
          {...markdownProps}
          block={block}
          blockCount={blocks.length}
          revealTailChars={revealTailCharsForBlock(block, text.length, revealTailChars)}
        />
      ))}
    </>
  );
}
