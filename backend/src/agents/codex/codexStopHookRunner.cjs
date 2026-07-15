'use strict';

const MAX_INPUT_BYTES = 1024 * 1024;
const endpoint = process.argv[2];
let input = '';
let inputBytes = 0;
let finished = false;

function writeResult(value) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function failOpen(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[michi-codex-stop-hook] fail-open: ${message.slice(0, 500)}\n`);
  writeResult({});
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBytes += Buffer.byteLength(chunk);
  if (inputBytes > MAX_INPUT_BYTES) {
    failOpen(new Error('Stop Hook payload exceeded 1 MiB'));
    process.exitCode = 0;
    process.stdin.destroy();
    return;
  }
  input += chunk;
});

process.stdin.on('end', async () => {
  if (finished) return;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('validator endpoint must be loopback HTTP');
    }
    const payload = JSON.parse(input);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`validator returned HTTP ${response.status}`);
    const result = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('validator returned a non-object response');
    }
    writeResult(result);
  } catch (error) {
    failOpen(error);
  }
});
