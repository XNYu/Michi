import { chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'win32') {
  const candidates = [
    resolve('node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    resolve('node_modules', 'node-pty', 'build', 'Release', 'spawn-helper'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) chmodSync(candidate, 0o755);
  }
}
