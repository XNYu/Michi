import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installMockApi } from '../fixtures/mockApi';

test.skip(process.env.MICHI_PANE_PERF !== '1', 'Set MICHI_PANE_PERF=1 to run the pane performance suite.');
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const STATE_SCHEMA_VERSION = 5;
const PROJECT_ID = 'perf-workspace';
const TREE_ID = 'perf-tree';
const ROOT_NODE_ID = 'n0';
const BASELINE_LABEL = process.env.MICHI_PERF_LABEL ?? 'baseline';
const OUT_DIR = process.env.MICHI_PERF_OUT ?? path.join(process.cwd(), 'e2e', '.perf');
const STREAMING_MARKDOWN_BLOCKS = process.env.MICHI_STREAMING_MARKDOWN_BLOCKS;

interface FrameStats {
  frames: number;
  durationMs: number;
  avg: number;
  p95: number;
  p99: number;
  max: number;
  over20: number;
  over33: number;
  over50: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
}

interface ScenarioResult {
  name: string;
  paneCount: number;
  frames?: FrameStats;
  interactionMaxMs?: number;
  heapBefore?: number | null;
  heapAfter?: number | null;
  heapAfterClose?: number | null;
  renderDelta: Record<string, number>;
  componentDelta: Record<string, number>;
  inactivePaneRenders?: Record<string, number>;
}

declare global {
  interface Window {
    __MICHI_RENDER_COUNTERS__?: {
      enabled?: boolean;
      counts: Record<string, number>;
      componentCounts: Record<string, number>;
      events?: unknown[];
      maxEvents?: number;
    };
  }
}

const results: ScenarioResult[] = [];

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function summarizeFrames(
  frames: number[],
  durationMs: number,
  longTasks: Array<{ duration: number }>,
): FrameStats {
  const total = frames.reduce((sum, n) => sum + n, 0);
  return {
    frames: frames.length,
    durationMs: Math.round(durationMs),
    avg: Math.round((total / Math.max(1, frames.length)) * 10) / 10,
    p95: Math.round(percentile(frames, 0.95) * 10) / 10,
    p99: Math.round(percentile(frames, 0.99) * 10) / 10,
    max: Math.round(Math.max(0, ...frames) * 10) / 10,
    over20: frames.filter((n) => n > 20).length,
    over33: frames.filter((n) => n > 33).length,
    over50: frames.filter((n) => n > 50).length,
    longTaskCount: longTasks.length,
    longTaskTotalMs: Math.round(longTasks.reduce((sum, n) => sum + n.duration, 0) * 10) / 10,
    longTaskMaxMs: Math.round(Math.max(0, ...longTasks.map((n) => n.duration)) * 10) / 10,
  };
}

function codeBlock(language: string, pane: number, turn: number, block: number): string {
  const fn = `pane${pane}Turn${turn}Block${block}`;
  if (language === 'ts') {
    return [
      '```ts',
      `export function ${fn}(items: Array<{ id: string; value: number }>) {`,
      '  return items',
      '    .filter((item) => item.value > 0)',
      '    .map((item, index) => ({ ...item, rank: index + 1 }))',
      '    .reduce((acc, item) => acc + item.value * item.rank, 0);',
      '}',
      '```',
    ].join('\n');
  }
  if (language === 'json') {
    return [
      '```json',
      JSON.stringify({
        pane,
        turn,
        block,
        metrics: { latencyMs: 42 + block, retries: block % 3, ok: true },
        tags: ['heavy', 'fixture', 'render'],
      }, null, 2),
      '```',
    ].join('\n');
  }
  return [
    '```bash',
    `for shard in pane-${pane} turn-${turn} block-${block}; do`,
    '  printf "checking %s\\n" "$shard"',
    '  sleep 0.01',
    'done',
    '```',
  ].join('\n');
}

function heavyAnswer(pane: number, turn: number): { beforeTool: string; afterTool: string } {
  const table = [
    '| Area | Baseline | Risk | Note |',
    '| --- | ---: | --- | --- |',
    `| Pane ${pane} markdown | ${turn * 17 + 11}ms | medium | repeated parser work |`,
    `| Pane ${pane} scroll | ${turn * 13 + 7}ms | high | layout and paint pressure |`,
    `| Pane ${pane} streaming | ${turn * 19 + 5}ms | high | token updates should stay local |`,
  ].join('\n');
  const list = [
    '- Keep the unchanged panes visually stable.',
    '- Preserve code blocks, tables, follow-ups, tool calls, and selection affordances.',
    '- Avoid direct root reads and keep tree-scoped pane state intact.',
    '- Make the transcript long enough that markdown/code rendering is meaningful.',
  ].join('\n');
  const blocks = Array.from({ length: 4 }, (_, i) =>
    codeBlock(i % 3 === 0 ? 'ts' : i % 3 === 1 ? 'json' : 'bash', pane, turn, i),
  ).join('\n\n');
  const afterBlocks = Array.from({ length: 2 }, (_, i) =>
    codeBlock(i % 2 === 0 ? 'ts' : 'json', pane, turn, i + 4),
  ).join('\n\n');
  return {
    beforeTool: [
      `### Pane ${pane} / turn ${turn}`,
      '',
      'This assistant response intentionally mixes markdown shapes that are common in real Michi transcripts.',
      '',
      table,
      '',
      list,
      '',
      blocks,
    ].join('\n'),
    afterTool: [
      'The tool result is followed by more prose so the renderer has to weave text and tool chips.',
      '',
      '> A quoted detail remains visible while other panes stay static.',
      '',
      afterBlocks,
      '',
      'Final paragraph with inline `code`, a [link](https://example.com), and enough text to wrap across several lines in a pane.',
    ].join('\n'),
  };
}

function makeNode(pane: number) {
  const nodeId = `n${pane}`;
  const messages = [];
  for (let turn = 0; turn < 4; turn += 1) {
    const assistantId = `a-${nodeId}-${turn}`;
    const toolId = `tool-${nodeId}-${turn}`;
    const answer = heavyAnswer(pane, turn);
    messages.push({
      id: `u-${nodeId}-${turn}`,
      role: 'user',
      text: `Please analyze pane ${pane}, turn ${turn}, including branch context and markdown-heavy notes.`,
      toolCalls: [],
      createdAt: 1_780_000_000_000 + pane * 10_000 + turn * 1_000,
    });
    messages.push({
      id: assistantId,
      role: 'assistant',
      text: '',
      toolCalls: [{
        id: toolId,
        title: 'read_file',
        status: 'completed',
        kind: 'tool',
        detail: `Collected pane ${pane} turn ${turn} fixture details.`,
      }],
      blocks: [
        { id: `b-${nodeId}-${turn}-answer-1`, kind: 'answer', rawText: answer.beforeTool },
        {
          id: `b-${nodeId}-${turn}-tool`,
          kind: 'tool',
          toolCallId: toolId,
          section: 'answer',
          rawOffset: answer.beforeTool.length,
        },
        { id: `b-${nodeId}-${turn}-answer-2`, kind: 'answer', rawText: answer.afterTool },
      ],
      streaming: false,
      createdAt: 1_780_000_000_500 + pane * 10_000 + turn * 1_000,
    });
  }
  return {
    nodeId,
    kind: 'chat',
    chatId: `mock-chat-${pane}`,
    runtimeId: 'mock',
    projectId: PROJECT_ID,
    parentNodeId: pane === 0 ? undefined : ROOT_NODE_ID,
    messages,
    followUps: [
      `Continue pane ${pane} analysis?`,
      `Branch pane ${pane} into a mitigation plan?`,
      `Summarize pane ${pane} risks?`,
    ],
    followUpsSourceMessageId: `a-${nodeId}-3`,
    title: `Heavy pane ${pane}`,
    status: 'idle',
    paneWidth: 680,
    viewedAt: Date.now(),
    lastAssistantAt: 1_780_000_004_500 + pane * 10_000,
  };
}

function makeSavedState(paneCount: number) {
  const nodes = Object.fromEntries(
    Array.from({ length: paneCount }, (_, pane) => [`n${pane}`, makeNode(pane)]),
  );
  const chatIds = Array.from({ length: paneCount }, (_, pane) => `n${pane}`);
  return {
    version: STATE_SCHEMA_VERSION,
    activeProjectId: PROJECT_ID,
    projects: [{
      id: PROJECT_ID,
      name: `${paneCount} Pane Heavy Perf`,
      chatIds,
      edges: chatIds.slice(1).map((target, idx) => ({
        source: ROOT_NODE_ID,
        target,
        kind: 'branch',
        anchorMessageId: `a-${ROOT_NODE_ID}-${idx % 4}`,
        createdAt: 1_780_000_010_000 + idx,
      })),
      trees: [{
        id: TREE_ID,
        rootNodeId: ROOT_NODE_ID,
        createdAt: 1_780_000_000_000,
        lastActiveAt: Date.now(),
      }],
      activeTreeId: TREE_ID,
      contexts: [],
      createdAt: 1_780_000_000_000,
    }],
    nodes,
  };
}

async function installPerfInit(page: Page, paneCount: number) {
  await page.addInitScript(({ state, streamingMarkdownBlocks }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('michi:migrated', '1');
    window.localStorage.setItem('michi:v1:state', JSON.stringify(state));
    window.localStorage.setItem('michi:perf', '1');
    window.localStorage.setItem('michi:ff:markdownRenderer', 'react-markdown');
    if (streamingMarkdownBlocks === '0' || streamingMarkdownBlocks === '1') {
      window.localStorage.setItem('michi:ff:streamingMarkdownBlocks', streamingMarkdownBlocks);
    }
    window.__MICHI_RENDER_COUNTERS__ = {
      enabled: true,
      counts: {},
      componentCounts: {},
      events: [],
      maxEvents: 100_000,
    };

    const originalFetch = window.fetch.bind(window);
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const url = new URL(rawUrl, window.location.href);
      if (method === 'POST' && /^\/api\/chats\/[^/]+\/message$/.test(url.pathname)) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode(frame('tool_call', {
              id: 'stream-tool-1',
              title: 'grep_transcript',
              status: 'running',
              kind: 'tool',
              detail: 'Scanning fixture transcript during streamed turn.',
            })));
            for (let i = 0; i < 96; i += 1) {
              const text = i % 12 === 0
                ? `\n\n### Streaming section ${i / 12 + 1}\n\n- token batch ${i}\n- pane-local update\n\n`
                : `streamed token batch ${i} with markdown-safe prose. `;
              controller.enqueue(encoder.encode(frame('chunk', { text })));
              await new Promise((resolve) => window.setTimeout(resolve, 16));
            }
            controller.enqueue(encoder.encode(frame('tool_call_update', {
              id: 'stream-tool-1',
              title: 'grep_transcript',
              status: 'completed',
              kind: 'tool',
              detail: 'Finished scanning fixture transcript.',
            })));
            controller.enqueue(encoder.encode(frame('follow_ups', {
              followUps: ['Inspect inactive panes?', 'Check heap?', 'Review scroll trace?'],
            })));
            controller.enqueue(encoder.encode(frame('done', { stopReason: 'end_turn' })));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        });
      }
      return originalFetch(input, init);
    };
  }, { state: makeSavedState(paneCount), streamingMarkdownBlocks: STREAMING_MARKDOWN_BLOCKS });
}

async function bootHeavyWorkspace(page: Page, paneCount: number) {
  await installMockApi(page);
  await installPerfInit(page, paneCount);
  await page.goto('/');
  await page.getByText(`${paneCount} Pane Heavy Perf`).first().waitFor({ state: 'visible', timeout: 15_000 });
  await clickFirstHomeRecent(page);
  await page.locator('.terminal-dashboard').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(page.locator('.terminal-pane')).toHaveCount(1, { timeout: 15_000 });
  for (let i = 1; i < paneCount; i += 1) {
    await dispatchAppShortcut(page, '\\');
    await expect(page.locator('.terminal-pane')).toHaveCount(i + 1, { timeout: 10_000 });
  }
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.terminal-pane').length === expected,
    paneCount,
  );
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-msg-id]').length >= expected * 8,
    paneCount,
  );
  await page.waitForTimeout(800);
}

async function clickFirstHomeRecent(page: Page) {
  await page.evaluate(() => {
    const caption = Array.from(document.querySelectorAll('div')).find(
      (el) => el.textContent?.trim().toLowerCase() === 'recent threads',
    );
    const row = caption?.parentElement?.children.item(1) as HTMLElement | null;
    if (!row) throw new Error('missing home recent row');
    row.click();
  });
}

async function dispatchAppShortcut(
  page: Page,
  key: string,
  opts: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
) {
  await page.evaluate(({ key, opts }) => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      ctrlKey: opts.ctrlKey ?? true,
      metaKey: opts.metaKey ?? false,
      altKey: opts.altKey ?? false,
      shiftKey: opts.shiftKey ?? false,
      bubbles: true,
      cancelable: true,
    }));
  }, { key, opts });
}

async function collectHeap(page: Page): Promise<number | null> {
  const client = await page.context().newCDPSession(page);
  try {
    await client.send('HeapProfiler.collectGarbage');
  } catch {
    // Not fatal; Chromium may reject this in unusual modes.
  } finally {
    await client.detach().catch(() => {});
  }
  return page.evaluate(() => {
    const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return memory.memory?.usedJSHeapSize ?? null;
  });
}

async function resetCounters(page: Page) {
  await page.evaluate(() => {
    const sink = window.__MICHI_RENDER_COUNTERS__;
    if (!sink) return;
    sink.counts = {};
    sink.componentCounts = {};
    sink.events = [];
  });
}

async function snapshotCounters(page: Page): Promise<{
  counts: Record<string, number>;
  componentCounts: Record<string, number>;
}> {
  return page.evaluate(() => {
    const sink = window.__MICHI_RENDER_COUNTERS__;
    return {
      counts: { ...(sink?.counts ?? {}) },
      componentCounts: { ...(sink?.componentCounts ?? {}) },
    };
  });
}

function diffRecord(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: Record<string, number> = {};
  for (const key of keys) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta !== 0) out[key] = delta;
  }
  return out;
}

function inactivePaneRenders(delta: Record<string, number>, activeNodeId: string, paneCount: number) {
  const out: Record<string, number> = {};
  for (let i = 0; i < paneCount; i += 1) {
    const nodeId = `n${i}`;
    if (nodeId === activeNodeId) continue;
    out[nodeId] = (delta[`TPane:${nodeId}`] ?? 0) + (delta[`PaneMessageList:${nodeId}`] ?? 0);
  }
  return out;
}

async function measureFrames(page: Page, durationMs: number, driveScroll: boolean): Promise<FrameStats> {
  const raw = await page.evaluate(async ({ durationMs, driveScroll }) => {
    const frames: number[] = [];
    const longTasks: Array<{ duration: number }> = [];
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ duration: entry.duration });
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    } catch {
      observer = null;
    }

    const strip = document.querySelector('.terminal-dashboard') as HTMLElement | null;
    if (!strip) throw new Error('missing .terminal-dashboard');
    const start = performance.now();
    let last = start;
    const maxScroll = Math.max(0, strip.scrollWidth - strip.clientWidth);

    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        frames.push(now - last);
        last = now;
        const elapsed = now - start;
        if (driveScroll && maxScroll > 0) {
          const phase = (elapsed % 2_500) / 2_500;
          const eased = (1 - Math.cos(phase * Math.PI * 2)) / 2;
          strip.scrollLeft = Math.round(maxScroll * eased);
        }
        if (elapsed < durationMs) {
          requestAnimationFrame(tick);
        } else {
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
    observer?.disconnect();
    return { frames, durationMs: performance.now() - start, longTasks };
  }, { durationMs, driveScroll });
  return summarizeFrames(raw.frames, raw.durationMs, raw.longTasks);
}

async function submitToPane(page: Page, nodeId: string, text: string) {
  await page.evaluate((targetNodeId) => {
    const strip = document.querySelector('.terminal-dashboard') as HTMLElement | null;
    const wrapper = document.querySelector(`.terminal-dashboard > [data-node-id="${targetNodeId}"]`) as HTMLElement | null;
    if (strip && wrapper) strip.scrollLeft = wrapper.offsetLeft;
  }, nodeId);
  const pane = page.locator(`.terminal-pane[data-node-id="${nodeId}"]`).first();
  await pane.click({ position: { x: 24, y: 24 } });
  const editor = pane.locator('[contenteditable="true"]').last();
  await editor.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function measureWithCounters(
  page: Page,
  name: string,
  paneCount: number,
  fn: () => Promise<{ frames?: FrameStats; interactionMaxMs?: number; heapAfterClose?: number | null }>,
  activeNodeId = 'n0',
) {
  await resetCounters(page);
  const heapBefore = await collectHeap(page);
  const before = await snapshotCounters(page);
  const measured = await fn();
  const after = await snapshotCounters(page);
  const heapAfter = await collectHeap(page);
  const renderDelta = diffRecord(before.counts, after.counts);
  const componentDelta = diffRecord(before.componentCounts, after.componentCounts);
  const result: ScenarioResult = {
    name,
    paneCount,
    heapBefore,
    heapAfter,
    renderDelta,
    componentDelta,
    inactivePaneRenders: inactivePaneRenders(renderDelta, activeNodeId, paneCount),
    ...measured,
  };
  results.push(result);
  console.log(`[pane-perf:${name}] ${JSON.stringify({
    frames: result.frames,
    componentDelta,
    inactivePaneRenders: result.inactivePaneRenders,
    heapBefore,
    heapAfter,
    heapAfterClose: result.heapAfterClose,
    interactionMaxMs: result.interactionMaxMs,
  })}`);
}

test.afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  const output = {
    label: BASELINE_LABEL,
    commit,
    generatedAt: new Date().toISOString(),
    scenarios: results,
  };
  const file = path.join(OUT_DIR, `pane-performance-${BASELINE_LABEL}.json`);
  writeFileSync(file, JSON.stringify(output, null, 2));
  console.log(`[pane-perf] wrote ${file}`);
});

test('4 pane heavy horizontal scroll, streaming isolation, and interactions', async ({ page }) => {
  await bootHeavyWorkspace(page, 4);

  await measureWithCounters(page, '4p-scroll-10s', 4, async () => ({
    frames: await measureFrames(page, 10_000, true),
  }));

  await measureWithCounters(page, '4p-stream-static-panes', 4, async () => {
    const streaming = measureFrames(page, 2_400, false);
    await submitToPane(page, 'n0', 'stream a measured pane-local update');
    await expect(page.locator('.terminal-pane[data-node-id="n0"] [data-streaming-tail="true"]')).toBeVisible({ timeout: 5_000 });
    const frames = await streaming;
    await expect(page.getByText('Inspect inactive panes?').first()).toBeVisible({ timeout: 8_000 });
    return { frames };
  }, 'n0');

  await measureWithCounters(page, '4p-focus-input-switch', 4, async () => {
    const durations: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const t0 = Date.now();
      await dispatchAppShortcut(page, 'Tab');
      await page.waitForTimeout(30);
      durations.push(Date.now() - t0);
    }
    const editor = page.locator('.terminal-pane[data-node-id="n0"] [contenteditable="true"]').last();
    await page.locator('.terminal-pane[data-node-id="n0"]').first().click({ position: { x: 32, y: 32 } });
    const t1 = Date.now();
    await editor.click();
    await page.keyboard.type('input latency sample');
    durations.push(Date.now() - t1);
    return { interactionMaxMs: Math.max(...durations) };
  });
});

test('6 pane heavy scroll and streaming pressure', async ({ page }) => {
  await bootHeavyWorkspace(page, 6);

  await measureWithCounters(page, '6p-scroll-pressure-10s', 6, async () => ({
    frames: await measureFrames(page, 10_000, true),
  }));

  await measureWithCounters(page, '6p-stream-pressure', 6, async () => {
    const streaming = measureFrames(page, 2_400, false);
    await submitToPane(page, 'n0', 'stream under six pane pressure');
    await expect(page.locator('.terminal-pane[data-node-id="n0"] [data-streaming-tail="true"]')).toBeVisible({ timeout: 5_000 });
    const frames = await streaming;
    await expect(page.getByText('Check heap?').first()).toBeVisible({ timeout: 8_000 });
    for (let i = 0; i < 5; i += 1) {
      await dispatchAppShortcut(page, 'w');
      await page.waitForTimeout(50);
    }
    const heapAfterClose = await collectHeap(page);
    return { frames, heapAfterClose };
  }, 'n0');
});
