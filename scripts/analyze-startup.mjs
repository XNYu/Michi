#!/usr/bin/env node

import fs from 'node:fs';

const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

if (files.length === 0) {
  console.error('Usage: node scripts/analyze-startup.mjs <log.jsonl> [more.log]');
  process.exit(1);
}

function parseLine(line) {
  const direct = tryParse(line);
  if (direct?.type === 'startup') return direct;

  const taggedStart = line.indexOf('{"type":"startup"');
  if (taggedStart !== -1) {
    const tagged = tryParse(line.slice(taggedStart));
    if (tagged?.type === 'startup') return tagged;
  }

  const firstBrace = line.indexOf('{');
  if (firstBrace !== -1) {
    const sliced = tryParse(line.slice(firstBrace));
    if (sliced?.type === 'startup') return sliced;
  }

  return null;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const rows = files
  .flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseLine)
      .filter((row) => row && typeof row.t === 'number');
  })
  .sort((a, b) => a.t - b.t);

if (rows.length === 0) {
  console.error('No startup rows found.');
  process.exit(1);
}

function first(name, after = -Infinity) {
  return rows.find((row) => row.name === name && row.t >= after) ?? null;
}

function firstOf(names, after = -Infinity) {
  for (const name of names) {
    const row = first(name, after);
    if (row) return row;
  }
  return null;
}

function span(label, startName, endNames) {
  const start = first(startName);
  const end = start ? firstOf(Array.isArray(endNames) ? endNames : [endNames], start.t) : null;
  return {
    label,
    ms: start && end ? end.t - start.t : null,
    start,
    end,
  };
}

function fmtMs(ms) {
  if (ms == null) return 'missing';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printSection(title, spans) {
  console.log(`\n${title}`);
  for (const s of spans) {
    console.log(`  ${s.label.padEnd(38)} ${fmtMs(s.ms)}`);
  }
}

const runIds = [...new Set(rows.map((row) => row.runId).filter(Boolean))];
const sources = [...new Set(rows.map((row) => row.source).filter(Boolean))];
const t0 = rows[0].t;

console.log(`Startup rows: ${rows.length}`);
console.log(`Files: ${files.join(', ')}`);
console.log(`Sources: ${sources.join(', ') || '(none)'}`);
console.log(`Run IDs: ${runIds.join(', ') || '(blank)'}`);

printSection('Desktop Shell', [
  span('main start -> app ready', 'electron_main_start', 'electron_app_ready'),
  span('main start -> window ready', 'electron_main_start', 'window_ready_to_show'),
  span('window create -> window ready', 'browser_window_create_start', 'window_ready_to_show'),
  span('renderer load start -> did finish load', 'renderer_load_start', 'renderer_did_finish_load'),
  span('renderer script -> app interactive', 'renderer_script_start', 'app_interactive'),
]);

printSection('Backend Boot', [
  span('backend fork -> health ready', 'backend_fork_start', 'backend_health_ready'),
  span('backend process -> listen ready', 'backend_process_start', 'express_listen_ready'),
  span('express listen start -> ready', 'express_listen_start', 'express_listen_ready'),
  span('warm start -> warm done/failed', 'chat_warm_start', ['chat_warm_done', 'chat_warm_failed']),
]);

printSection('Kiro Warm', [
  span('kiro spawn -> initialized', 'kiro_spawn_start', 'kiro_initialize_done'),
  span('kiro session/new start -> done', 'kiro_session_new_start', 'kiro_session_new_done'),
]);

printSection('Renderer State', [
  span('state hydrate start -> done', 'state_hydrate_start', 'state_hydrate_done'),
]);

printSection('Workspace Warm', [
  span('frontend warm start -> done', 'workspace_warm_start', ['workspace_warm_done', 'workspace_warm_gave_up']),
  span('backend warm route -> done', 'warm_route_start', ['warm_route_done', 'warm_route_failed', 'warm_route_skipped']),
]);

printSection('First Chat', [
  span('first send -> ensure done', 'first_message_send', 'ensure_session_done'),
  span('ensure start -> ensure done', 'ensure_session_start', 'ensure_session_done'),
  span('first send -> first SSE event', 'first_message_send', 'first_sse_event'),
  span('first send -> first chunk', 'first_message_send', 'first_sse_chunk'),
  span('stream request -> first chunk', 'stream_request_start', 'first_sse_chunk'),
  span('backend stream route -> first event', 'stream_route_start', 'stream_route_first_event'),
]);

function formatMeta(row) {
  const skip = new Set(['type', 'runId', 'source', 'name', 't']);
  const parts = [];
  for (const [key, value] of Object.entries(row)) {
    if (skip.has(key)) continue;
    parts.push(`${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

console.log('\nTimeline');
for (const row of rows) {
  const rel = `${row.t - t0}ms`.padStart(8);
  const source = String(row.source ?? '').padEnd(14);
  console.log(`  +${rel}  ${source} ${row.name}${formatMeta(row)}`);
}
