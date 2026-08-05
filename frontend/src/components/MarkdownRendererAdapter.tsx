import ReactMarkdown from 'react-markdown';
import type { Components as ReactMarkdownComponents } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererAdapterProps {
  text: string;
  remarkPluginsAfterGfm?: unknown[];
  legacyRemarkPlugins?: unknown[];
  legacyRehypePlugins: unknown[];
  legacyComponents?: ReactMarkdownComponents;
}

export default function MarkdownRendererAdapter({
  text,
  remarkPluginsAfterGfm,
  legacyRemarkPlugins,
  legacyRehypePlugins,
  legacyComponents,
}: MarkdownRendererAdapterProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        ...((remarkPluginsAfterGfm as any[]) ?? []),
        ...((legacyRemarkPlugins as any[]) ?? []),
      ]}
      rehypePlugins={legacyRehypePlugins as any[]}
      components={legacyComponents}
    >
      {text}
    </ReactMarkdown>
  );
}
