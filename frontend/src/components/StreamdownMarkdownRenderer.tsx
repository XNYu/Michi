import { Streamdown, type StreamdownProps } from 'streamdown';
import { code } from './streamdownCodePlugin';
import { cjk } from '@streamdown/cjk';

export interface StreamdownMarkdownRendererProps {
  text: string;
  components?: StreamdownProps['components'];
  rehypePlugins?: StreamdownProps['rehypePlugins'];
  isAnimating?: boolean;
}

// Streamdown's PluginConfig types `code.getSupportedLanguages()` as
// `BundledLanguage[]` (the full Shiki literal union). Our slim plugin only
// supports a curated subset, so we cast to satisfy that contract.
const streamdownPlugins = { code, cjk } as unknown as StreamdownProps['plugins'];

export default function StreamdownMarkdownRenderer({
  text,
  components,
  rehypePlugins,
  isAnimating = false,
}: StreamdownMarkdownRendererProps) {
  return (
    <Streamdown
      mode={isAnimating ? 'streaming' : 'static'}
      parseIncompleteMarkdown
      normalizeHtmlIndentation
      controls={false}
      linkSafety={{ enabled: false }}
      plugins={streamdownPlugins}
      rehypePlugins={rehypePlugins}
      isAnimating={isAnimating}
      animated={isAnimating ? { animation: 'fadeIn', duration: 80, sep: 'word', stagger: 0 } : false}
      components={components}
    >
      {text}
    </Streamdown>
  );
}
