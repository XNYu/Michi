#!/usr/bin/env node

import fs from 'node:fs';

const files = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

if (files.length === 0) {
  console.error('Usage: node scripts/analyze-metrics.mjs <log.jsonl> [more.log]');
  process.exit(1);
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseLine(line) {
  const direct = tryParse(line);
  if (direct?.type === 'metric') return direct;

  const taggedStart = line.indexOf('{"type":"metric"');
  if (taggedStart !== -1) {
    const tagged = tryParse(line.slice(taggedStart));
    if (tagged?.type === 'metric') return tagged;
  }

  const firstBrace = line.indexOf('{');
  if (firstBrace !== -1) {
    const sliced = tryParse(line.slice(firstBrace));
    if (sliced?.type === 'metric') return sliced;
  }

  return null;
}

const rows = files
  .flatMap((file) => fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseLine)
    .filter(Boolean))
  .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

if (rows.length === 0) {
  console.error('No metric rows found.');
  process.exit(1);
}

function pct(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function fmtMs(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

const runIds = [...new Set(rows.map((row) => row.runId).filter(Boolean))];
const sources = [...new Set(rows.map((row) => row.source).filter(Boolean))];

console.log(`Metric rows: ${rows.length}`);
console.log(`Files: ${files.join(', ')}`);
console.log(`Sources: ${sources.join(', ') || '(none)'}`);
console.log(`Run IDs: ${runIds.join(', ') || '(blank)'}`);

const byKey = new Map();
for (const row of rows) {
  const key = `${row.kind || 'unknown'}:${row.name || 'unnamed'}`;
  const group = byKey.get(key) ?? [];
  group.push(row);
  byKey.set(key, group);
}

console.log('\nMeasures');
for (const [key, group] of [...byKey].filter(([key]) => key.startsWith('measure:')).sort()) {
  const values = group.map((row) => Number(row.durMs)).filter(Number.isFinite);
  if (values.length === 0) continue;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const name = key.slice('measure:'.length);
  console.log(
    `  ${name.padEnd(42)} n=${String(values.length).padStart(3)} avg=${fmtMs(avg).padStart(8)} p50=${fmtMs(pct(values, 50)).padStart(8)} p95=${fmtMs(pct(values, 95)).padStart(8)} max=${fmtMs(Math.max(...values)).padStart(8)}`,
  );
}

console.log('\nCounters');
for (const [key, group] of [...byKey].filter(([key]) => key.startsWith('counter:')).sort()) {
  const total = group.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
  const name = key.slice('counter:'.length);
  console.log(`  ${name.padEnd(42)} total=${fmtNum(total)} n=${group.length}`);
}

console.log('\nMarks');
for (const [key, group] of [...byKey].filter(([key]) => key.startsWith('mark:')).sort()) {
  const name = key.slice('mark:'.length);
  console.log(`  ${name.padEnd(42)} n=${group.length}`);
}
