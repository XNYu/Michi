import React, { Profiler, memo, type ProfilerOnRenderCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Block, Streamdown, parseMarkdownIntoBlocks, type BlockProps } from 'streamdown';
import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { cjk } from '@streamdown/cjk';
import { mermaid } from '@streamdown/mermaid';
import StreamdownSnapshotTail from './StreamdownSnapshotTail';
import MarkdownContent, {
  type MarkdownFeatureProfile,
} from '../../../frontend/src/components/MarkdownContent';
import StreamingMarkdownContent from '../../../frontend/src/components/terminal/StreamingMarkdownContent';
import { MARKDOWN_REINTERPRET_HZ_STORAGE_KEY } from '../../../frontend/src/components/terminal/markdownReinterpretationFlag';
import { fixtures } from './fixtures';
import 'katex/dist/katex.min.css';
import 'streamdown/styles.css';
import './benchmark.css';

type RendererId =
  | 'michi-3hz-core'
  | 'michi-3hz-full'
  | 'streamdown-hybrid-3hz-full'
  | 'streamdown-word-core'
  | 'streamdown-word-full'
  | 'streamdown-char-full';
type RenderPhase = 'streaming' | 'final' | 'static';

interface RunRequest {
  renderer: RendererId;
  fixtureId: string;
  chunkSize: number;
  cadence: 'raf' | 'burst';
  staticIterations?: number;
  variant?: number;
}

interface ProfileSample {
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
  commitTime: number;
}

interface RunResult {
  renderer: RendererId;
  fixtureId: string;
  fixtureLabel: string;
  chars: number;
  chunkSize: number;
  cadence: 'raf' | 'burst' | 'static';
  updates: number;
  wallMs: number;
  renderCallTotalMs: number;
  renderCallP50Ms: number;
  renderCallP95Ms: number;
  renderCallMaxMs: number;
  profilerActualMs: number;
  profilerP95Ms: number;
  profilerCommits: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  frameP95Ms: number;
  frameMaxMs: number;
  framesOver25Ms: number;
  finalizeRenderMs: number;
  domNodes: number;
  markdownContentRenders: number;
  michiSemanticSnapshots: number;
  streamdownBlockSplits: number;
  streamdownBlockRenders: number;
  michiSemanticLagAvgChars: number;
  michiSemanticLagMaxChars: number;
  finalTextChars: number;
  codeActionButtons: number;
  lineNumberedLines: number;
  tableActionButtons: number;
  mermaidSvgs: number;
  directionalBlocks: number;
  cjkStrongNodes: number;
  cjkDeleteNodes: number;
}

declare global {
  interface Window {
    __MICHI_RENDER_COUNTERS__?: {
      enabled?: boolean;
      counts: Record<string, number>;
      componentCounts: Record<string, number>;
    };
    __MARKDOWN_STREAM_BENCHMARK__?: {
      fixtures: Array<{ id: string; label: string; chars: number }>;
      renderers: RendererId[];
      run: (request: RunRequest) => Promise<RunResult>;
      warmup: () => Promise<void>;
    };
  }
}

const featuredPlugins = {
  code,
  math: createMathPlugin({ singleDollarTextMath: true }),
  cjk,
};
const fullPlugins = { ...featuredPlugins, mermaid };
const disabledLinkSafety = { enabled: false } as const;
const enabledLinkSafety = { enabled: true } as const;
const wordAnimation = { sep: 'word' } as const;
const charAnimation = { sep: 'char' } as const;
const fullControls = {
  code: { copy: true, download: true },
  table: { copy: true, download: true, fullscreen: true },
  mermaid: { copy: true, download: true, fullscreen: true, panZoom: true },
} as const;
const fullMermaidOptions = { config: { securityLevel: 'strict' } } as const;
const michiFullFeatures: MarkdownFeatureProfile = {
  autoDirection: true,
  cjk: true,
  codeDownload: true,
  codeLineNumbers: true,
  linkSafety: true,
  mermaid: true,
  normalizeHtmlIndentation: true,
  strikethrough: true,
  tableControls: true,
};

let streamdownBlockSplits = 0;
let streamdownBlockRenders = 0;

function instrumentedBlockSplitter(markdown: string): string[] {
  streamdownBlockSplits += 1;
  return parseMarkdownIntoBlocks(markdown);
}

const InstrumentedStreamdownBlock = memo(function InstrumentedStreamdownBlock(props: BlockProps) {
  streamdownBlockRenders += 1;
  return <Block {...props} />;
});

function BenchmarkRenderer({
  renderer,
  text,
  phase,
}: {
  renderer: RendererId;
  text: string;
  phase: RenderPhase;
}) {
  const streaming = phase === 'streaming';
  if (renderer.startsWith('michi-')) {
    const features = renderer === 'michi-3hz-full' ? michiFullFeatures : undefined;
    return streaming ? (
      <StreamingMarkdownContent
        features={features}
        text={text}
        revealTailChars={1}
        reinterpretStrategy={{ mode: 'fixed', hz: 3 }}
      />
    ) : (
      <MarkdownContent features={features} text={text} />
    );
  }

  if (renderer === 'streamdown-hybrid-3hz-full') {
    return (
      <StreamdownSnapshotTail
        BlockComponent={InstrumentedStreamdownBlock}
        animated={wordAnimation}
        controls={fullControls}
        dir="auto"
        lineNumbers
        linkSafety={enabledLinkSafety}
        mermaid={fullMermaidOptions}
        normalizeHtmlIndentation
        parseMarkdownIntoBlocksFn={instrumentedBlockSplitter}
        plugins={fullPlugins}
        revealTailChars={1}
        streaming={streaming}
        text={text}
      />
    );
  }

  const full = renderer.endsWith('-full');
  return (
    <Streamdown
      BlockComponent={InstrumentedStreamdownBlock}
      animated={renderer === 'streamdown-char-full' ? charAnimation : wordAnimation}
      caret={full ? 'block' : undefined}
      controls={full ? fullControls : false}
      dir={full ? 'auto' : undefined}
      isAnimating={streaming}
      lineNumbers={full}
      linkSafety={full ? enabledLinkSafety : disabledLinkSafety}
      mermaid={full ? fullMermaidOptions : undefined}
      mode={phase === 'static' ? 'static' : 'streaming'}
      normalizeHtmlIndentation={full}
      parseIncompleteMarkdown
      parseMarkdownIntoBlocksFn={instrumentedBlockSplitter}
      plugins={full ? fullPlugins : featuredPlugins}
    >
      {text}
    </Streamdown>
  );
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await nextFrame();
  await nextFrame();
}

function codeHighlightComplete(host: HTMLElement, renderer: RendererId): boolean {
  if (renderer.startsWith('michi-')) {
    const blocks = [...host.querySelectorAll('.michi-code-block')];
    return blocks.length > 0 && blocks.every((block) => block.querySelector('.michi-code-token'));
  }
  const bodies = [...host.querySelectorAll('[data-streamdown="code-block-body"]')];
  return bodies.length > 0 && bodies.every((body) =>
    [...body.querySelectorAll<HTMLElement>('span[style]')].some((token) => {
      const color = token.style.getPropertyValue('--sdm-c').trim();
      return color.length > 0 && color !== 'inherit';
    }),
  );
}

function featureRenderingComplete(host: HTMLElement, renderer: RendererId): boolean {
  if (!renderer.endsWith('-full')) return true;
  const selector = renderer.startsWith('michi-')
    ? '[data-michi-mermaid] [role="img"] > svg'
    : '[data-streamdown="mermaid"] [role="img"] > svg';
  return host.querySelectorAll(selector).length >= 4;
}

async function activateLazyFeatureRendering(host: HTMLElement, renderer: RendererId): Promise<void> {
  if (!renderer.startsWith('streamdown-') || !renderer.endsWith('-full')) return;
  const diagrams = [...host.querySelectorAll<HTMLElement>('[data-streamdown="mermaid-block"]')];
  for (const diagram of diagrams) {
    diagram.scrollIntoView({ block: 'center' });
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  }
  window.scrollTo(0, 0);
}

async function settleDom(
  host: HTMLElement,
  renderer: RendererId,
  fixtureId?: string,
  maxMs = 5_000,
  quietMs = 150,
): Promise<void> {
  const startedAt = performance.now();
  let lastMutationAt = startedAt;
  const observer = new MutationObserver(() => {
    lastMutationAt = performance.now();
  });
  observer.observe(host, { attributes: true, characterData: true, childList: true, subtree: true });
  try {
    if (fixtureId === 'feature-parity') {
      await activateLazyFeatureRendering(host, renderer);
    }
    while (performance.now() - startedAt < maxMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      const highlightReady = fixtureId !== 'code-heavy' || codeHighlightComplete(host, renderer);
      const featuresReady = fixtureId !== 'feature-parity' || featureRenderingComplete(host, renderer);
      if (highlightReady && featuresReady && performance.now() - lastMutationAt >= quietMs) break;
    }
    await settle();
  } finally {
    observer.disconnect();
  }
}

function prefixes(markdown: string, chunkSize: number): string[] {
  const out: string[] = [];
  for (let end = Math.min(chunkSize, markdown.length); end < markdown.length; end += chunkSize) {
    out.push(markdown.slice(0, end));
  }
  out.push(markdown);
  return out;
}

const CODE_VARIANT_MARKER = '__BENCH_VARIANT__';

function markdownVariant(markdown: string, variant: number): string {
  if (!markdown.includes(CODE_VARIANT_MARKER)) return markdown;
  const replacement = String(Math.max(0, Math.floor(variant)))
    .padStart(CODE_VARIANT_MARKER.length, '0')
    .slice(-CODE_VARIANT_MARKER.length);
  return markdown.replaceAll(CODE_VARIANT_MARKER, replacement);
}

function newSurface(): { host: HTMLDivElement; root: Root } {
  const mount = document.querySelector('#benchmark-root');
  if (!mount) throw new Error('Missing #benchmark-root');
  mount.replaceChildren();
  window.scrollTo(0, 0);
  const host = document.createElement('div');
  host.className = 'benchmark-surface';
  mount.appendChild(host);
  return { host, root: createRoot(host) };
}

async function run(request: RunRequest): Promise<RunResult> {
  const fixture = fixtures.find((candidate) => candidate.id === request.fixtureId);
  if (!fixture) throw new Error(`Unknown fixture: ${request.fixtureId}`);
  if (!Number.isInteger(request.chunkSize) || request.chunkSize <= 0) throw new Error('chunkSize must be positive');

  window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, '3');
  window.__MICHI_RENDER_COUNTERS__ = { enabled: true, counts: {}, componentCounts: {} };
  streamdownBlockSplits = 0;
  streamdownBlockRenders = 0;

  const { host, root } = newSurface();
  const profileSamples: ProfileSample[] = [];
  const renderCallDurations: number[] = [];
  const frameIntervals: number[] = [];
  const semanticLags: number[] = [];
  const longTasks: number[] = [];
  let lastFrameAt = 0;
  let lastMichiSnapshotChars = -1;
  let michiSemanticSnapshots = 0;

  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration, baseDuration, _startTime, commitTime) => {
    profileSamples.push({ phase, actualDuration, baseDuration, commitTime });
  };

  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    observer = null;
  }

  const render = (text: string, phase: RenderPhase) => {
    const startedAt = performance.now();
    flushSync(() => {
      root.render(
        <Profiler id="markdown-benchmark" onRender={onRender}>
          <BenchmarkRenderer phase={phase} renderer={request.renderer} text={text} />
        </Profiler>,
      );
    });
    renderCallDurations.push(performance.now() - startedAt);
  };

  const startedAt = performance.now();
  let updates = 0;
  let finalizeRenderMs = 0;
  const baseVariant = request.variant ?? 0;
  const runMarkdown = markdownVariant(fixture.markdown, baseVariant);

  if (request.staticIterations) {
    for (let iteration = 0; iteration < request.staticIterations; iteration += 1) {
      render(markdownVariant(fixture.markdown, baseVariant + iteration), 'static');
      updates += 1;
      if (iteration < request.staticIterations - 1) render('', 'static');
    }
  } else {
    for (const text of prefixes(runMarkdown, request.chunkSize)) {
      if (request.cadence === 'raf') {
        const frameAt = await nextFrame();
        if (lastFrameAt > 0) frameIntervals.push(frameAt - lastFrameAt);
        lastFrameAt = frameAt;
      }
      render(text, 'streaming');
      updates += 1;
      if (
        request.renderer.startsWith('michi-') ||
        request.renderer === 'streamdown-hybrid-3hz-full'
      ) {
        const snapshot = host.querySelector('[data-markdown-snapshot-chars]');
        const snapshotChars = Number(snapshot?.getAttribute('data-markdown-snapshot-chars') ?? text.length);
        if (snapshotChars !== lastMichiSnapshotChars) {
          lastMichiSnapshotChars = snapshotChars;
          michiSemanticSnapshots += 1;
        }
        semanticLags.push(Math.max(0, text.length - snapshotChars));
      }
    }
    await settle();
    const finalizeStartedAt = performance.now();
    render(runMarkdown, 'final');
    finalizeRenderMs = performance.now() - finalizeStartedAt;
  }

  await settleDom(host, request.renderer, fixture.id);
  const wallMs = performance.now() - startedAt;
  observer?.disconnect();

  const finalTextChars = host.textContent?.length ?? 0;
  const domNodes = host.querySelectorAll('*').length;
  const profilerDurations = profileSamples.map((sample) => sample.actualDuration);
  const markdownContentRenders = window.__MICHI_RENDER_COUNTERS__.componentCounts.MarkdownContent ?? 0;
  const codeActionButtons = host.querySelectorAll(
    '.michi-code-copy, [data-michi-code-download], [data-streamdown="code-block-copy-button"], [data-streamdown="code-block-download-button"]',
  ).length;
  const lineNumberedLines = request.renderer.startsWith('michi-')
    ? host.querySelectorAll('[data-line-number]').length
    : request.renderer.endsWith('-full')
      ? host.querySelectorAll('[data-streamdown="code-block-body"] code > span').length
      : 0;
  const tableActionButtons = request.renderer.startsWith('michi-')
    ? host.querySelectorAll('[data-michi-table-controls] button').length
    : host.querySelectorAll('[data-streamdown="table-wrapper"] button').length;
  const mermaidSvgs = host.querySelectorAll(
    '[data-michi-mermaid] [role="img"] > svg, [data-streamdown="mermaid"] [role="img"] > svg',
  ).length;
  const directionalBlocks = host.querySelectorAll('[dir="ltr"], [dir="rtl"], [dir="auto"]').length;
  const cjkStrongNodes = [...host.querySelectorAll('strong, [data-streamdown="strong"]')].filter(
    (node) => node.textContent?.includes('该强调包含句号'),
  ).length;
  const cjkDeleteNodes = [...host.querySelectorAll('del')].filter(
    (node) => node.textContent?.includes('该删除线包含句号'),
  ).length;

  root.unmount();
  host.remove();
  window.__MICHI_RENDER_COUNTERS__ = undefined;

  return {
    renderer: request.renderer,
    fixtureId: fixture.id,
    fixtureLabel: fixture.label,
    chars: runMarkdown.length,
    chunkSize: request.chunkSize,
    cadence: request.staticIterations ? 'static' : request.cadence,
    updates,
    wallMs,
    renderCallTotalMs: sum(renderCallDurations),
    renderCallP50Ms: percentile(renderCallDurations, 0.5),
    renderCallP95Ms: percentile(renderCallDurations, 0.95),
    renderCallMaxMs: Math.max(0, ...renderCallDurations),
    profilerActualMs: sum(profilerDurations),
    profilerP95Ms: percentile(profilerDurations, 0.95),
    profilerCommits: profileSamples.length,
    longTaskCount: longTasks.length,
    longTaskTotalMs: sum(longTasks),
    longTaskMaxMs: Math.max(0, ...longTasks),
    frameP95Ms: percentile(frameIntervals, 0.95),
    frameMaxMs: Math.max(0, ...frameIntervals),
    framesOver25Ms: frameIntervals.filter((duration) => duration > 25).length,
    finalizeRenderMs,
    domNodes,
    markdownContentRenders,
    michiSemanticSnapshots,
    streamdownBlockSplits,
    streamdownBlockRenders,
    michiSemanticLagAvgChars: semanticLags.length > 0 ? sum(semanticLags) / semanticLags.length : 0,
    michiSemanticLagMaxChars: Math.max(0, ...semanticLags),
    finalTextChars,
    codeActionButtons,
    lineNumberedLines,
    tableActionButtons,
    mermaidSvgs,
    directionalBlocks,
    cjkStrongNodes,
    cjkDeleteNodes,
  };
}

async function warmup(): Promise<void> {
  const warmText = [
    '## Warmup 热身',
    '',
    '| A | B |',
    '| --- | --- |',
    '| one | **two** |',
    '',
    '```ts',
    'const warmed = true;',
    '```',
    '',
    '$$E = mc^2$$',
    '',
    '```mermaid',
    'flowchart LR',
    '  Warm --> Ready',
    '```',
    '',
    '<details><summary>HTML</summary><p>ready</p></details>',
  ].join('\n');

  for (const renderer of [
    'michi-3hz-core',
    'michi-3hz-full',
    'streamdown-hybrid-3hz-full',
    'streamdown-word-core',
    'streamdown-word-full',
    'streamdown-char-full',
  ] as RendererId[]) {
    const { host, root } = newSurface();
    flushSync(() => root.render(<BenchmarkRenderer phase="streaming" renderer={renderer} text={warmText} />));
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    flushSync(() => root.render(<BenchmarkRenderer phase="final" renderer={renderer} text={warmText} />));
    await settleDom(host, renderer);
    flushSync(() => root.render(<BenchmarkRenderer phase="static" renderer={renderer} text={warmText} />));
    await settleDom(host, renderer);
    root.unmount();
    host.remove();
  }
}

window.__MARKDOWN_STREAM_BENCHMARK__ = {
  fixtures: fixtures.map(({ id, label, markdown }) => ({ id, label, chars: markdown.length })),
  renderers: [
    'michi-3hz-core',
    'michi-3hz-full',
    'streamdown-hybrid-3hz-full',
    'streamdown-word-core',
    'streamdown-word-full',
    'streamdown-char-full',
  ],
  run,
  warmup,
};

document.querySelector('#benchmark-root')!.textContent = 'Benchmark harness ready';
