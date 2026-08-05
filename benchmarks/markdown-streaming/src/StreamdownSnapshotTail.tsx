import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Streamdown,
  defaultRehypePlugins,
  type StreamdownProps,
} from 'streamdown';
import {
  MarkdownStreamingTail,
  MarkdownStreamingTailProvider,
} from '../../../frontend/src/components/MarkdownStreamingTail';
import { computeTailRemend } from '../../../frontend/src/lib/inlineStreamRemend';

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const TAIL_CONTAINER_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'blockquote',
]);

const DEFAULT_REHYPE_PLUGINS = Object.values(defaultRehypePlugins);
const SNAPSHOT_TAIL_SENTINEL = '\uE000michi-stream-tail\uE001';

function findTailContainer(node: HastNode): HastNode | null {
  if (Array.isArray(node.children)) {
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const match = findTailContainer(node.children[index]);
      if (match) return match;
    }
  }

  if (node.type !== 'element' || !node.tagName) return null;
  return TAIL_CONTAINER_TAGS.has(node.tagName) ? node : null;
}

function removeTailSentinel(node: HastNode): boolean {
  if (node.type === 'text' && typeof node.value === 'string') {
    if (!node.value.includes(SNAPSHOT_TAIL_SENTINEL)) return false;
    node.value = node.value.replace(SNAPSHOT_TAIL_SENTINEL, '');
    return true;
  }
  if (!Array.isArray(node.children)) return false;
  return node.children.some(removeTailSentinel);
}

/**
 * Adds a React-owned marker after Streamdown's sanitize/harden pipeline. Code
 * blocks deliberately fall back to a root-level marker: inserting an element
 * inside their HAST `code` node would change Streamdown's raw-code extraction.
 */
function appendSnapshotTailPlugin() {
  return function transform(tree: HastNode) {
    // Streamdown runs rehype once per parsed block. The sentinel is appended to
    // the complete snapshot source, so only its final block receives a marker.
    if (!removeTailSentinel(tree)) return;
    const container = findTailContainer(tree) ?? tree;
    if (!Array.isArray(container.children)) container.children = [];
    container.children.push({
      type: 'element',
      tagName: 'michi-stream-tail',
      properties: {},
      children: [],
    });
  };
}

function SnapshotTailMarker() {
  return <MarkdownStreamingTail />;
}

export type StreamdownSnapshotTailProps = Omit<
  StreamdownProps,
  'children' | 'isAnimating' | 'mode' | 'parseIncompleteMarkdown'
> & {
  revealTailChars?: number;
  snapshotIntervalMs?: number;
  streaming: boolean;
  text: string;
};

/**
 * Experimental bridge: Streamdown owns semantic rendering and its plugin/UI
 * surface, while Michi owns the streaming cadence and lightweight pending tail.
 */
export default function StreamdownSnapshotTail({
  text,
  streaming,
  snapshotIntervalMs = 1_000 / 3,
  revealTailChars = 1,
  components,
  rehypePlugins,
  ...streamdownProps
}: StreamdownSnapshotTailProps) {
  const normalizedIntervalMs = Number.isFinite(snapshotIntervalMs)
    ? Math.max(1, snapshotIntervalMs)
    : 1_000 / 3;
  const [snapshotText, setSnapshotText] = useState(text);
  const snapshotTextRef = useRef(text);
  const latestTextRef = useRef(text);
  const lastSnapshotAtRef = useRef(Date.now());
  const timerRef = useRef<number | null>(null);
  latestTextRef.current = text;

  const appendOnly = text.startsWith(snapshotTextRef.current);
  const renderedSnapshot = streaming && appendOnly ? snapshotText : text;

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    const flush = () => {
      timerRef.current = null;
      const next = latestTextRef.current;
      snapshotTextRef.current = next;
      lastSnapshotAtRef.current = Date.now();
      setSnapshotText((current) => current === next ? current : next);
    };

    if (!streaming) {
      clearTimer();
      snapshotTextRef.current = text;
      lastSnapshotAtRef.current = Date.now();
      setSnapshotText((current) => current === text ? current : text);
      return;
    }
    if (!text.startsWith(snapshotTextRef.current)) {
      clearTimer();
      flush();
      return;
    }
    if (text === snapshotTextRef.current || timerRef.current !== null) return;

    const elapsed = Date.now() - lastSnapshotAtRef.current;
    timerRef.current = window.setTimeout(
      flush,
      Math.max(0, normalizedIntervalMs - elapsed),
    );
  }, [normalizedIntervalMs, streaming, text]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const mergedComponents = useMemo(
    () => ({
      ...(components ?? {}),
      'michi-stream-tail': SnapshotTailMarker,
    }) as StreamdownProps['components'],
    [components],
  );
  const mergedRehypePlugins = useMemo(
    () => [
      ...((rehypePlugins ?? DEFAULT_REHYPE_PLUGINS) as unknown[]),
      appendSnapshotTailPlugin,
    ],
    [rehypePlugins],
  );

  if (!streaming) {
    return (
      <Streamdown
        {...streamdownProps}
        components={components}
        isAnimating={false}
        mode="static"
        rehypePlugins={rehypePlugins}
      >
        {text}
      </Streamdown>
    );
  }

  const remendedSnapshot = computeTailRemend(renderedSnapshot);
  const pendingText = text.startsWith(renderedSnapshot)
    ? text.slice(renderedSnapshot.length)
    : '';

  return (
    <div
      className="contents"
      data-hybrid-streamdown-snapshot
      data-markdown-reinterpret-strategy="fixed"
      data-markdown-reinterpret-hz={1_000 / normalizedIntervalMs}
      data-markdown-snapshot-chars={renderedSnapshot.length}
    >
      <MarkdownStreamingTailProvider
        inlineState={remendedSnapshot.endState}
        revealTailChars={revealTailChars}
        snapshotCarry={remendedSnapshot.carry}
        text={pendingText}
      >
        <Streamdown
          {...streamdownProps}
          caret={undefined}
          components={mergedComponents}
          isAnimating
          mode="streaming"
          parseIncompleteMarkdown={false}
          rehypePlugins={mergedRehypePlugins as StreamdownProps['rehypePlugins']}
        >
          {remendedSnapshot.displayText + SNAPSHOT_TAIL_SENTINEL}
        </Streamdown>
      </MarkdownStreamingTailProvider>
    </div>
  );
}
