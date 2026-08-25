import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function assertPort(value, label) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return port;
}

export function isPortAvailable(port, host = '127.0.0.1') {
  const candidate = assertPort(port, 'port');
  return new Promise((resolveAvailable) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolveAvailable(false));
    server.listen({ port: candidate, host, exclusive: true }, () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

export async function findOpenPort(startPort = 3001, options = {}) {
  const start = assertPort(startPort, 'startPort');
  const maxAttempts = Number(options.maxAttempts ?? 100);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }

  for (let offset = 0; offset < maxAttempts && start + offset <= 65535; offset += 1) {
    const port = start + offset;
    if (await isPortAvailable(port, options.host)) return port;
  }
  throw new Error(`No open port found from ${start} after ${maxAttempts} attempts`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(String(await findOpenPort(process.argv[2] ?? 3001)));
  } catch (error) {
    console.error(`[dev-port] ${error.message}`);
    process.exitCode = 1;
  }
}
