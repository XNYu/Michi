#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const port = Number(process.env.MICHI_MARKDOWN_BENCH_PORT ?? 4317);
const baseUrl = `http://127.0.0.1:${port}`;
const repeats = Number(process.env.MICHI_MARKDOWN_BENCH_REPEATS ?? 3);
const noWrite = process.env.MICHI_MARKDOWN_BENCH_NO_WRITE === '1';
const requestedFixtureIds = (process.env.MICHI_MARKDOWN_BENCH_FIXTURES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const outputDir = resolve(here, 'results');
const renderers = [
  'michi-3hz-core',
  'michi-3hz-full',
  'streamdown-hybrid-3hz-full',
  'streamdown-word-core',
  'streamdown-word-full',
  'streamdown-char-full',
];
const chunkSizes = [128, 512];

function metric(snapshot, name) {
  return snapshot.metrics.find((candidate) => candidate.name === name)?.value ?? 0;
}

function deltaMetric(before, after, name, scale = 1) {
  return (metric(after, name) - metric(before, name)) * scale;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function fmt(value, digits = 1) {
  return Number(value).toFixed(digits);
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Vite did not start at ${url}: ${lastError?.message ?? 'timeout'}`);
}

function rotate(values, amount) {
  const offset = amount % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function aggregate(results) {
  const groups = new Map();
  for (const result of results) {
    const key = [result.cadence, result.fixtureId, result.chunkSize, result.renderer].join('|');
    const rows = groups.get(key) ?? [];
    rows.push(result);
    groups.set(key, rows);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const sample = rows[0];
    const fields = [
      'wallMs',
      'taskDurationMs',
      'scriptDurationMs',
      'layoutDurationMs',
      'recalcStyleDurationMs',
      'profilerActualMs',
      'profilerP95Ms',
      'profilerCommits',
      'renderCallTotalMs',
      'renderCallP50Ms',
      'renderCallP95Ms',
      'renderCallMaxMs',
      'frameP95Ms',
      'frameMaxMs',
      'framesOver25Ms',
      'longTaskCount',
      'longTaskTotalMs',
      'longTaskMaxMs',
      'finalizeRenderMs',
      'domNodes',
      'markdownContentRenders',
      'michiSemanticSnapshots',
      'streamdownBlockSplits',
      'streamdownBlockRenders',
      'michiSemanticLagAvgChars',
      'michiSemanticLagMaxChars',
      'codeActionButtons',
      'lineNumberedLines',
      'tableActionButtons',
      'mermaidSvgs',
      'directionalBlocks',
      'cjkStrongNodes',
      'cjkDeleteNodes',
    ];
    const medians = Object.fromEntries(fields.map((field) => [field, median(rows.map((row) => row[field]))]));
    return { key, cadence: sample.cadence, fixtureId: sample.fixtureId, fixtureLabel: sample.fixtureLabel, chars: sample.chars, chunkSize: sample.chunkSize, renderer: sample.renderer, samples: rows.length, ...medians };
  });
}

function rendererLabel(renderer) {
  if (renderer === 'michi-3hz-core') return 'Michi 3Hz core';
  if (renderer === 'michi-3hz-full') return 'Michi 3Hz full features';
  if (renderer === 'streamdown-hybrid-3hz-full') return 'Streamdown + Michi 3Hz snapshot/tail';
  if (renderer === 'streamdown-word-core') return 'Streamdown Word core';
  if (renderer === 'streamdown-word-full') return 'Streamdown Word full features';
  return 'Streamdown Char full features';
}

function verifyHybridStaticParity(report) {
  const fields = [
    'cjkStrongNodes',
    'cjkDeleteNodes',
    'codeActionButtons',
    'lineNumberedLines',
    'tableActionButtons',
    'mermaidSvgs',
    'directionalBlocks',
    'domNodes',
  ];
  const hybrid = report.aggregates.find((row) =>
    row.cadence === 'static' &&
    row.fixtureId === 'feature-parity' &&
    row.renderer === 'streamdown-hybrid-3hz-full');
  const streamdown = report.aggregates.find((row) =>
    row.cadence === 'static' &&
    row.fixtureId === 'feature-parity' &&
    row.renderer === 'streamdown-word-full');
  if (!hybrid || !streamdown) throw new Error('Missing static feature-parity rows');
  for (const field of fields) {
    if (hybrid[field] !== streamdown[field]) {
      throw new Error(`Hybrid feature parity failed for ${field}: ${hybrid[field]} !== ${streamdown[field]}`);
    }
  }
}

function makeMarkdown(report) {
  const suiteRows = (cadence, renderer, chunkSize) => report.aggregates.filter((row) =>
    row.cadence === cadence &&
    row.renderer === renderer &&
    (chunkSize === undefined || row.chunkSize === chunkSize));
  const total = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0);
  const maximum = (rows, field) => Math.max(0, ...rows.map((row) => row[field]));
  const average = (rows, field) => rows.length > 0
    ? total(rows, field) / rows.length
    : 0;

  const lines = [
    '# Streaming Markdown hybrid snapshot/tail comparison',
    '',
    `Generated: ${report.generatedAt}`,
    `Browser: ${report.environment.browserVersion}`,
    `Machine: ${report.environment.platform} / ${report.environment.arch}`,
    `Streamdown: 2.5.0; repeats: ${report.repeats}; each update paced by requestAnimationFrame`,
    '',
  ];

  for (const chunkSize of report.chunkSizes) {
    lines.push(`## Streaming summary — ${chunkSize} chars/update`, '');
    lines.push('Strategy | Task CPU total | Script CPU total | Wall total | React render total | render call p95 worst | frame p95 worst | >25ms frames | long tasks | semantic lag avg / max');
    lines.push('--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:');
    for (const renderer of report.renderers) {
      const rows = suiteRows('raf', renderer, chunkSize);
      const hasSnapshots = renderer.startsWith('michi-') || renderer === 'streamdown-hybrid-3hz-full';
      lines.push([
        rendererLabel(renderer),
        `${fmt(total(rows, 'taskDurationMs'))}ms`,
        `${fmt(total(rows, 'scriptDurationMs'))}ms`,
        `${fmt(total(rows, 'wallMs'))}ms`,
        `${fmt(total(rows, 'profilerActualMs'))}ms`,
        `${fmt(maximum(rows, 'renderCallP95Ms'))}ms`,
        `${fmt(maximum(rows, 'frameP95Ms'))}ms`,
        fmt(total(rows, 'framesOver25Ms'), 0),
        fmt(total(rows, 'longTaskCount'), 0),
        hasSnapshots
          ? `${fmt(average(rows, 'michiSemanticLagAvgChars'))} / ${fmt(maximum(rows, 'michiSemanticLagMaxChars'), 0)} chars`
          : 'n/a',
      ].join(' | '));
    }
    lines.push('');
  }

  lines.push('## Feature overhead and head-to-head CPU', '');
  lines.push('Chunk | Michi full / core (feature fixture) | Streamdown Word full / core (feature fixture) | Michi full / Streamdown Word full (feature fixture) | Michi full / Streamdown Word full (all fixtures)');
  lines.push('---: | ---: | ---: | ---: | ---:');
  for (const chunkSize of report.chunkSizes) {
    const cpu = (renderer) => total(suiteRows('raf', renderer, chunkSize), 'taskDurationMs');
    const featureCpu = (renderer) => report.aggregates.find((row) =>
      row.cadence === 'raf' &&
      row.chunkSize === chunkSize &&
      row.fixtureId === 'feature-parity' &&
      row.renderer === renderer)?.taskDurationMs ?? 0;
    const ratio = (value, baseline) => baseline > 0 ? `${fmt(value / baseline, 2)}x` : 'n/a';
    lines.push([
      `${chunkSize} chars/update`,
      ratio(featureCpu('michi-3hz-full'), featureCpu('michi-3hz-core')),
      ratio(featureCpu('streamdown-word-full'), featureCpu('streamdown-word-core')),
      ratio(featureCpu('michi-3hz-full'), featureCpu('streamdown-word-full')),
      ratio(cpu('michi-3hz-full'), cpu('streamdown-word-full')),
    ].join(' | '));
  }

  lines.push('', '## Hybrid snapshot/tail head-to-head CPU', '');
  lines.push('Chunk | Hybrid / Michi full | Hybrid / Streamdown Word full | Hybrid / Streamdown Char full');
  lines.push('---: | ---: | ---: | ---:');
  for (const chunkSize of report.chunkSizes) {
    const cpu = (renderer) => total(suiteRows('raf', renderer, chunkSize), 'taskDurationMs');
    const ratio = (value, baseline) => baseline > 0 ? `${fmt(value / baseline, 2)}x` : 'n/a';
    const hybrid = cpu('streamdown-hybrid-3hz-full');
    lines.push([
      `${chunkSize} chars/update`,
      ratio(hybrid, cpu('michi-3hz-full')),
      ratio(hybrid, cpu('streamdown-word-full')),
      ratio(hybrid, cpu('streamdown-char-full')),
    ].join(' | '));
  }

  lines.push('', '## Rendered feature audit (full feature fixture, static median)', '');
  lines.push('Strategy | CJK strong | CJK delete | code actions | numbered lines | table actions | Mermaid SVGs | direction | DOM nodes');
  lines.push('--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:');
  for (const renderer of report.renderers) {
    const row = report.aggregates.find((candidate) =>
      candidate.cadence === 'static' &&
      candidate.fixtureId === 'feature-parity' &&
      candidate.renderer === renderer);
    if (!row) continue;
    lines.push([
      rendererLabel(renderer),
      fmt(row.cjkStrongNodes, 0),
      fmt(row.cjkDeleteNodes, 0),
      fmt(row.codeActionButtons, 0),
      fmt(row.lineNumberedLines, 0),
      fmt(row.tableActionButtons, 0),
      fmt(row.mermaidSvgs, 0),
      fmt(row.directionalBlocks, 0),
      fmt(row.domNodes, 0),
    ].join(' | '));
  }

  lines.push('## Streaming detail (fixture medians)', '');
  lines.push('Fixture | chunk | Strategy | Task CPU | Script CPU | wall | render total | render p95 | frame p95 / max | >25ms | long tasks | final render');
  lines.push('--- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:');

  for (const row of report.aggregates.filter((candidate) => candidate.cadence === 'raf')) {
    lines.push([
      row.fixtureLabel,
      row.chunkSize,
      rendererLabel(row.renderer),
      `${fmt(row.taskDurationMs)}ms`,
      `${fmt(row.scriptDurationMs)}ms`,
      `${fmt(row.wallMs)}ms`,
      `${fmt(row.profilerActualMs)}ms`,
      `${fmt(row.renderCallP95Ms)}ms`,
      `${fmt(row.frameP95Ms)} / ${fmt(row.frameMaxMs)}ms`,
      fmt(row.framesOver25Ms, 0),
      fmt(row.longTaskCount, 0),
      `${fmt(row.finalizeRenderMs)}ms`,
    ].join(' | '));
  }

  lines.push('', '## Snapshot semantic lag', '');
  lines.push('Fixture | chunk | Strategy | semantic snapshots | average lag | max lag');
  lines.push('--- | ---: | --- | ---: | ---: | ---:');
  for (const row of report.aggregates.filter((candidate) =>
    candidate.cadence === 'raf' && (
      candidate.renderer.startsWith('michi-') ||
      candidate.renderer === 'streamdown-hybrid-3hz-full'
    ))) {
    lines.push([
      row.fixtureLabel,
      row.chunkSize,
      rendererLabel(row.renderer),
      fmt(row.michiSemanticSnapshots, 0),
      `${fmt(row.michiSemanticLagAvgChars)} chars`,
      `${fmt(row.michiSemanticLagMaxChars, 0)} chars`,
    ].join(' | '));
  }

  lines.push('', '## Static full-document render (one new document, median)', '');
  lines.push('Fixture | chars | Strategy | Task CPU | Script CPU | wall | Profiler | render call | DOM nodes');
  lines.push('--- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---:');
  for (const row of report.aggregates.filter((candidate) => candidate.cadence === 'static')) {
    lines.push([
      row.fixtureLabel,
      row.chars,
      rendererLabel(row.renderer),
      `${fmt(row.taskDurationMs)}ms`,
      `${fmt(row.scriptDurationMs)}ms`,
      `${fmt(row.wallMs)}ms`,
      `${fmt(row.profilerActualMs)}ms`,
      `${fmt(row.renderCallP95Ms)}ms`,
      fmt(row.domNodes, 0),
    ].join(' | '));
  }

  lines.push('', '## Instrumentation notes', '');
  lines.push('- Core modes match the previous renderer-focused benchmark: code/math/CJK plugins enabled for Streamdown, but optional controls, line numbers, link safety, Mermaid, RTL detection, and caret disabled.');
  lines.push('- Full modes enable CJK edge parsing, semantic strikethrough, code line numbers/download, table copy/download/fullscreen, Mermaid with controls, automatic direction, link safety, HTML indentation normalization, and a streaming caret where supported.');
  lines.push('- Michi full features are opt-in. Production remains on the existing 3Hz core profile unless explicitly changed later.');
  lines.push('- Streamdown Word and Char full modes have identical features; only animation segmentation differs (`sep: word` vs `sep: char`).');
  lines.push('- The hybrid keeps Streamdown components/plugins but feeds them Michi-style 3Hz semantic snapshots. Pending text is rendered immediately by the lightweight Michi tail; Streamdown word animation, Shiki, Mermaid, and the unified pipeline run only when the snapshot changes.');
  lines.push('- In an unfinished fenced code block, the hybrid tail is rendered immediately after the code block rather than inside Streamdown\'s code body. Injecting a React marker into the code HAST would change Streamdown\'s raw-code extraction; this is a known prototype visual limitation.');
  lines.push('- Task/Script/Layout metrics come from Chrome DevTools Protocol. React Profiler time and frame intervals come from the page harness. Module loading and the first async syntax-highlighter initialization are warmed before measurement.');
  lines.push('- Michi semantic lag counts source characters waiting for the next Markdown reinterpretation. Pending characters remain visible immediately through the lightweight tail renderer; only full Markdown semantics lag.');
  lines.push('- Wall time includes final async highlighting and a 150ms DOM quiet window, so Task CPU and render-call latency are the cleaner measures of main-thread cost.');
  lines.push('- Code fixtures use equal-length unique source markers for every measured document so syntax-highlighting result caches cannot make later samples artificially cheap.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('MICHI_MARKDOWN_BENCH_REPEATS must be 1..10');
  const viteBin = resolve(repoRoot, 'node_modules/vite/bin/vite.js');
  const vite = spawn(process.execPath, [viteBin, '--config', resolve(here, 'vite.config.mts'), '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let viteLog = '';
  vite.stdout.on('data', (chunk) => { viteLog += chunk.toString(); });
  vite.stderr.on('data', (chunk) => { viteLog += chunk.toString(); });

  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.__MARKDOWN_STREAM_BENCHMARK__.warmup());

    const allFixtureMeta = await page.evaluate(() => window.__MARKDOWN_STREAM_BENCHMARK__.fixtures);
    const fixtureMeta = requestedFixtureIds.length > 0
      ? allFixtureMeta.filter((fixture) => requestedFixtureIds.includes(fixture.id))
      : allFixtureMeta;
    if (fixtureMeta.length === 0) {
      throw new Error(`No fixtures matched MICHI_MARKDOWN_BENCH_FIXTURES=${requestedFixtureIds.join(',')}`);
    }
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');
    await client.send('HeapProfiler.enable');
    const results = [];
    let variantSequence = 10_000;

    async function measuredRun(request) {
      const measuredRequest = { ...request, variant: variantSequence };
      variantSequence += 1;
      await client.send('HeapProfiler.collectGarbage');
      const before = await client.send('Performance.getMetrics');
      const pageResult = await page.evaluate(
        (value) => window.__MARKDOWN_STREAM_BENCHMARK__.run(value),
        measuredRequest,
      );
      const after = await client.send('Performance.getMetrics');
      const result = {
        ...pageResult,
        repeat: request.repeat,
        taskDurationMs: deltaMetric(before, after, 'TaskDuration', 1000),
        scriptDurationMs: deltaMetric(before, after, 'ScriptDuration', 1000),
        layoutDurationMs: deltaMetric(before, after, 'LayoutDuration', 1000),
        recalcStyleDurationMs: deltaMetric(before, after, 'RecalcStyleDuration', 1000),
        jsHeapDeltaBytes: deltaMetric(before, after, 'JSHeapUsedSize'),
        nodeDelta: deltaMetric(before, after, 'Nodes'),
      };
      results.push(result);
      console.log(`[${results.length}] ${result.cadence} ${result.fixtureId} chunk=${result.chunkSize} ${result.renderer} task=${fmt(result.taskDurationMs)}ms profiler=${fmt(result.profilerActualMs)}ms`);
    }

    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const fixture of fixtureMeta) {
        for (const renderer of rotate(renderers, repeat + fixtureMeta.indexOf(fixture))) {
          await measuredRun({ renderer, fixtureId: fixture.id, chunkSize: fixture.chars, cadence: 'burst', staticIterations: 1, variant: 1_000 + repeat, repeat });
        }
      }
    }

    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const chunkSize of chunkSizes) {
        for (const fixture of fixtureMeta) {
          for (const renderer of rotate(renderers, repeat + chunkSizes.indexOf(chunkSize) + fixtureMeta.indexOf(fixture))) {
            await measuredRun({
              renderer,
              fixtureId: fixture.id,
              chunkSize,
              cadence: 'raf',
              variant: 2_000 + chunkSizes.indexOf(chunkSize) * 100 + repeat,
              repeat,
            });
          }
        }
      }
    }

    await client.detach();
    const report = {
      generatedAt: new Date().toISOString(),
      repeats,
      chunkSizes,
      renderers,
      fixtures: fixtureMeta,
      environment: {
        browserVersion: browser.version(),
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
      results,
      aggregates: aggregate(results),
    };
    verifyHybridStaticParity(report);
    if (!noWrite) {
      mkdirSync(outputDir, { recursive: true });
      const json = `${JSON.stringify(report, null, 2)}\n`;
      const markdown = makeMarkdown(report);
      const outputNames = ['latest', 'hybrid-snapshot-comparison'];
      if (requestedFixtureIds.length === 0 && repeats === 3) {
        outputNames.push('2026-08-05-hybrid-snapshot');
      }
      for (const outputName of outputNames) {
        const jsonPath = resolve(outputDir, `${outputName}.json`);
        const markdownPath = resolve(outputDir, `${outputName}.md`);
        if (outputName.startsWith('2026-') && (existsSync(jsonPath) || existsSync(markdownPath))) {
          throw new Error(`Refusing to overwrite immutable benchmark artifact: ${outputName}`);
        }
        writeFileSync(jsonPath, json);
        writeFileSync(markdownPath, markdown);
        console.log(`Wrote ${jsonPath}`);
        console.log(`Wrote ${markdownPath}`);
      }
    }
  } catch (error) {
    if (viteLog) console.error(viteLog);
    throw error;
  } finally {
    await browser?.close();
    vite.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
