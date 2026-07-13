import ReactMarkdown from 'react-markdown';
import type { Components as ReactMarkdownComponents } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererAdapterProps {
  text: string;
  legacyRemarkPlugins?: unknown[];
  legacyRehypePlugins: unknown[];
  legacyComponents?: ReactMarkdownComponents;
}

export default function MarkdownRendererAdapter({
  text,
  legacyRemarkPlugins,
  legacyRehypePlugins,
  legacyComponents,
}: MarkdownRendererAdapterProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, ...((legacyRemarkPlugins as any[]) ?? [])]}
      rehypePlugins={legacyRehypePlugins as any[]}
      components={legacyComponents}
    >
      {text}
    </ReactMarkdown>
  );
}
