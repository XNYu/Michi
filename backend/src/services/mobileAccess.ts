import fs from 'node:fs';
import type { MobileAccessProvider } from 'michi-shared';

/** Restore only an explicit preference for this build's supported provider. */
export function readMobileAccessChoice(file: string, provider: MobileAccessProvider = 'tailscale'): boolean {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved.enabled === true && saved.provider === provider;
  } catch { return false; }
}

export function saveMobileAccessChoice(file: string, enabled: boolean, provider: MobileAccessProvider = 'tailscale'): void {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify({ enabled, provider }) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
