import React, { useEffect, useState } from 'react';
import { createCodePlugin } from './shikiCodePlugin';
import type { CodeHighlighterPlugin, HighlightResult } from './shikiCodePlugin';
import CodeBlockPlainLines from './CodeBlockPlainLines';

type HighlightOptions = Parameters<CodeHighlighterPlugin['highlight']>[0];
type HighlightToken = HighlightResult['tokens'][number][number];
type CSSVars = React.CSSProperties & Record<`--${string}`, string | number | undefined>;

const CODE_THEMES: HighlightOptions['themes'] = ['github-light', 'github-dark'];
const codeHighlighter = createCodePlugin({ themes: CODE_THEMES });

function tokenStyle(token: HighlightToken): CSSVars | undefined {
  const htmlStyle = token.htmlStyle;
  if (!htmlStyle) return undefined;

  const style: CSSVars = {};
  for (const [key, value] of Object.entries(htmlStyle)) {
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (key === 'color') {
      style['--michi-code-token'] = value;
    } else if (key === 'background-color') {
      style['--michi-code-token-bg'] = value;
    } else {
      (style as Record<string, string | number | undefined>)[key] = value;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function useShikiHighlight(source: string, language: string) {
  const [result, setResult] = useState<HighlightResult | null>(null);

  useEffect(() => {
    let active = true;
    setResult(null);

    const next = codeHighlighter.highlight(
      {
        code: source,
        language: (language || 'text') as HighlightOptions['language'],
        themes: CODE_THEMES,
      },
      (asyncResult) => {
        if (active) setResult(asyncResult);
      },
    );
    if (next) setResult(next);

    return () => {
      active = false;
    };
  }, [source, language]);

  return result;
}

function HighlightedCodeLines({ result }: { result: HighlightResult }) {
  return (
    <>
      {result.tokens.map((line, lineIndex) => (
        <span className="michi-code-line" key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <span
              className="michi-code-token"
              key={`${lineIndex}-${tokenIndex}`}
              style={tokenStyle(token)}
            >
              {token.content}
            </span>
          ))}
        </span>
      ))}
    </>
  );
}

export default function LegacyHighlightedCode({
  source,
  language,
}: {
  source: string;
  language: string;
}) {
  const result = useShikiHighlight(source, language);
  return result ? <HighlightedCodeLines result={result} /> : <CodeBlockPlainLines source={source} />;
}
