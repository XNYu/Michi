import ReactMarkdown from 'react-markdown';
import type { Components as ReactMarkdownComponents, UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererAdapterProps {
  text: string;
  remarkPluginsAfterGfm?: unknown[];
  legacyRemarkPlugins?: unknown[];
  legacyRehypePlugins: unknown[];
  legacyComponents?: ReactMarkdownComponents;
  /** Omitted: react-markdown's default, which keeps only web-safe URL schemes. */
  urlTransform?: UrlTransform;
}

export default function MarkdownRendererAdapter({
  text,
  remarkPluginsAfterGfm,
  legacyRemarkPlugins,
  legacyRehypePlugins,
  legacyComponents,
  urlTransform,
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
      {...(urlTransform ? { urlTransform } : {})}
    >
      {text}
    </ReactMarkdown>
  );
}
