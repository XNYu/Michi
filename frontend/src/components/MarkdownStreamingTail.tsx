import React, { createContext, useContext } from 'react';

interface MarkdownStreamingTailValue {
  text: string;
  revealTailChars?: number;
}

const MarkdownStreamingTailContext = createContext<MarkdownStreamingTailValue>({ text: '' });

export function MarkdownStreamingTailProvider({
  children,
  text,
  revealTailChars,
}: {
  children: React.ReactNode;
  text: string;
  revealTailChars?: number;
}) {
  return (
    <MarkdownStreamingTailContext.Provider value={{ text, revealTailChars }}>
      {children}
    </MarkdownStreamingTailContext.Provider>
  );
}

/**
 * A deliberately tiny context consumer used inside the last rendered Markdown
 * block. Smooth text updates re-render only this span, not react-markdown.
 */
export function MarkdownStreamingTail() {
  const { text, revealTailChars } = useContext(MarkdownStreamingTailContext);
  if (!text) return null;

  // The Markdown snapshot may be up to one third of a second old, so only
  // animate the tiny newly displayed suffix. All older tail text remains a
  // plain text node and react-markdown is never involved in this update.
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
