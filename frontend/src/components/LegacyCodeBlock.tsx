import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import CodeBlockPlainLines from './CodeBlockPlainLines';

const languageClassRe = /(?:^|\s)language-([^\s]+)/;
const LegacyHighlightedCode = React.lazy(() => import('./LegacyHighlightedCode'));

export function languageFromClassName(className: string | undefined): string {
  return className?.match(languageClassRe)?.[1] ?? '';
}

export function trimCodeFenceNewline(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

export interface LegacyCodeBlockProps {
  text: string;
  className?: string;
  language?: string;
  deferHighlight?: boolean;
  lineNumbers?: boolean;
  showDownload?: boolean;
  tail?: React.ReactNode;
  'data-michi-code-block'?: boolean;
}

function LegacyCodeBlock({
  text,
  className,
  language,
  deferHighlight = false,
  lineNumbers = false,
  showDownload = false,
  tail,
}: LegacyCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const source = useMemo(() => trimCodeFenceNewline(text), [text]);
  const resolvedLanguage = language || languageFromClassName(className) || 'text';
  const shouldHighlight = !deferHighlight && resolvedLanguage !== 'text' && source.trim().length > 0;

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const copyCode = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(source);
    } catch {
      return;
    }
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const downloadCode = () => {
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `code.${resolvedLanguage === 'text' ? 'txt' : resolvedLanguage}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const copyButton = (
    <button
      aria-label="Copy code"
      className={copied ? 'michi-code-copy is-copied' : 'michi-code-copy'}
      onClick={() => void copyCode()}
      title="copy code"
      type="button"
    >
      {copied ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );

  return (
    <div
      className="michi-code-block"
      data-language={resolvedLanguage}
      data-michi-code-block
    >
      <div className="michi-code-header">
        <span className="michi-code-language">{resolvedLanguage}</span>
      </div>
      <div className="michi-code-body">
        {showDownload ? (
          <div className="michi-code-actions">
            {copyButton}
            <button
              aria-label="Download code"
              className="michi-code-download"
              data-michi-code-download
              onClick={downloadCode}
              type="button"
            >
              ↓
            </button>
          </div>
        ) : copyButton}
        <div className="michi-code-scroll">
          <pre className="michi-code-pre">
            <code className={className}>
              {shouldHighlight ? (
                <Suspense fallback={<CodeBlockPlainLines source={source} tail={tail} lineNumbers={lineNumbers} />}>
                  <LegacyHighlightedCode language={resolvedLanguage} source={source} tail={tail} lineNumbers={lineNumbers} />
                </Suspense>
              ) : (
                <CodeBlockPlainLines source={source} tail={tail} lineNumbers={lineNumbers} />
              )}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
}

export default React.memo(LegacyCodeBlock);
