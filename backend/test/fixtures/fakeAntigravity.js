#!/usr/bin/env node
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes('--version')) {
  process.stdout.write('1.1.1\n');
  process.exit(0);
}

if (args[0] === 'models') {
  process.stdout.write([
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.1 Pro (High)',
    'Claude Sonnet 4.6 (Thinking)',
  ].join('\n') + '\n');
  process.exit(0);
}

if (args.at(-1) === 'agents') {
  const roots = args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);
  const found = roots.some((root) => fs.existsSync(require('node:path').join(
    root,
    '.agents',
    'agents',
    'michi',
    'agent.md',
  )));
  process.stdout.write(found ? 'Available agents:\n  michi\n' : 'Available agents:\n');
  process.exit(0);
}

const logPath = valueAfter('--log-file');
const conversationId = valueAfter('--conversation') || randomUUID();
const prompt = valueAfter('--print') || '';

if (process.env.FAKE_AGY_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(args));
}
if (logPath) {
  fs.mkdirSync(require('node:path').dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `I0000 server.go:861] Created conversation ${conversationId}\n`);
}

if (prompt.includes('FAIL_TURN')) {
  process.stderr.write('fake agy failure\n');
  process.exit(7);
}

if (prompt.includes('SLOW_TURN')) {
  process.stdout.write('started');
  const timer = setInterval(() => process.stdout.write('.'), 1000);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return;
}

if (prompt.includes('RECALL_TOKEN')) {
  process.stdout.write('AGY_PROBE_OK\n');
  process.exit(0);
}

if (prompt.includes('SPLIT_UTF8')) {
  const bytes = Buffer.from('天空是蓝色的。\n');
  process.stdout.write(bytes.subarray(0, 2));
  setTimeout(() => {
    process.stdout.write(bytes.subarray(2));
    process.exit(0);
  }, 20);
  return;
}

process.stdout.write('hello ');
setTimeout(() => {
  process.stdout.write('from agy\n');
  process.exit(0);
}, 20);
