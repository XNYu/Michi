import React, { createContext, useContext } from 'react';

const MarkdownStreamingTailContext = createContext('');

export function MarkdownStreamingTailProvider({
  children,
  text,
}: {
  children: React.ReactNode;
  text: string;
}) {
  return (
    <MarkdownStreamingTailContext.Provider value={text}>
      {children}
    </MarkdownStreamingTailContext.Provider>
  );
}

/**
 * A deliberately tiny context consumer used inside the last rendered Markdown
 * block. Smooth text updates re-render only this span, not react-markdown.
 */
export function MarkdownStreamingTail() {
  const text = useContext(MarkdownStreamingTailContext);
  if (!text) return null;
  return (
    <span data-markdown-pending-tail style={{ whiteSpace: 'pre-wrap' }}>
      {text}
    </span>
  );
}
