import React, { createContext, useContext, useMemo } from 'react';
import type { ChildAnchor } from '../../state/branchAnchors';
import { MarkdownQuoteMarksContext, type MarkdownQuoteMarks } from '../markdownQuoteMarks';
import { BranchQuoteUnderline, type BranchQuoteAnchor } from './BranchQuoteUnderline';

interface BranchQuoteDetails {
  anchors: ReadonlyMap<string, ChildAnchor>;
  onOpenBranch?: (childNodeId: string) => void;
}

const BranchQuoteDetailsContext = createContext<BranchQuoteDetails | null>(null);

/** One underlined stretch, naming the branches as they are now (title, status). */
function BranchQuoteMark({ keys, children }: { keys: readonly string[]; children: React.ReactNode }) {
  const details = useContext(BranchQuoteDetailsContext);
  const anchors = useMemo(() => keys.flatMap((key): BranchQuoteAnchor[] => {
    const anchor = details?.anchors.get(key);
    if (!anchor) return [];
    return [{
      childNodeId: anchor.childNodeId,
      title: anchor.title,
      createdAt: anchor.createdAt,
      status: anchor.status,
      question: anchor.question,
      reply: anchor.reply,
      onOpen: () => details?.onOpenBranch?.(anchor.childNodeId),
    }];
  }), [details, keys]);
  if (anchors.length === 0) return <>{children}</>;
  return <BranchQuoteUnderline anchors={anchors}>{children}</BranchQuoteUnderline>;
}

const renderMark: MarkdownQuoteMarks['render'] = (keys, children) => (
  <BranchQuoteMark keys={keys}>{children}</BranchQuoteMark>
);

/**
 * Underlines, in the Markdown below, the passages that child branches quoted
 * from this message (each branch's first message carries its selection as
 * quotedText). Hovering, focusing or tapping an underline shows the branches.
 */
export function BranchQuoteMarks({
  anchors,
  onOpenBranch,
  children,
}: {
  anchors?: readonly ChildAnchor[];
  onOpenBranch?: (childNodeId: string) => void;
  children: React.ReactNode;
}) {
  // Keyed on the quotes alone: a new value re-parses every Markdown block of
  // the message, while titles and status reach the marks through context.
  const quotesKey = JSON.stringify(
    (anchors ?? []).flatMap((a) => (a.quotedText?.trim() ? [[a.childNodeId, a.quotedText]] : [])),
  );
  const marks = useMemo((): MarkdownQuoteMarks | null => {
    const entries = JSON.parse(quotesKey) as [string, string][];
    if (entries.length === 0) return null;
    return { quotes: entries.map(([key, text]) => ({ key, text })), render: renderMark };
  }, [quotesKey]);
  const details = useMemo((): BranchQuoteDetails => ({
    anchors: new Map((anchors ?? []).map((a) => [a.childNodeId, a])),
    onOpenBranch,
  }), [anchors, onOpenBranch]);
  // Always mounted: a first quoting branch must not remount the message,
  // which would reset its expanded thought and tool blocks.
  return (
    <BranchQuoteDetailsContext.Provider value={details}>
      <MarkdownQuoteMarksContext.Provider value={marks}>{children}</MarkdownQuoteMarksContext.Provider>
    </BranchQuoteDetailsContext.Provider>
  );
}
