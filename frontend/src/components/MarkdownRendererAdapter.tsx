import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components as ReactMarkdownComponents } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MarkdownRendererKind } from './markdownRendererFlag';
import type { StreamdownMarkdownRendererProps } from './StreamdownMarkdownRenderer';

const StreamdownMarkdownRenderer = React.lazy(() => import('./StreamdownMarkdownRenderer'));

interface MarkdownRendererAdapterProps {
  text: string;
  renderer: MarkdownRendererKind;
  legacyRehypePlugins: unknown[];
  streamdownRehypePlugins?: StreamdownMarkdownRendererProps['rehypePlugins'];
  legacyComponents?: ReactMarkdownComponents;
  streamdownComponents?: StreamdownMarkdownRendererProps['components'];
  isAnimating?: boolean;
}

export default function MarkdownRendererAdapter({
  text,
  renderer,
  legacyRehypePlugins,
  streamdownRehypePlugins,
  legacyComponents,
  streamdownComponents,
  isAnimating = false,
}: MarkdownRendererAdapterProps) {
  if (renderer === 'streamdown') {
    return (
      <React.Suspense
        fallback={(
          <LegacyMarkdownRenderer
            text={text}
            rehypePlugins={legacyRehypePlugins}
            components={legacyComponents}
          />
        )}
      >
        <StreamdownMarkdownRenderer
          text={text}
          components={streamdownComponents}
          rehypePlugins={streamdownRehypePlugins}
          isAnimating={isAnimating}
        />
      </React.Suspense>
    );
  }

  return (
    <LegacyMarkdownRenderer
      text={text}
      rehypePlugins={legacyRehypePlugins}
      components={legacyComponents}
    />
  );
}

function LegacyMarkdownRenderer({
  text,
  rehypePlugins,
  components,
}: {
  text: string;
  rehypePlugins: unknown[];
  components?: ReactMarkdownComponents;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins as any[]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}
