import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

it('points the web app manifest at icons that ship in public/', () => {
  const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.json'), 'utf8'));
  expect(manifest.icons.length).toBeGreaterThan(0);
  for (const icon of manifest.icons) {
    expect(existsSync(join(publicDir, icon.src)), icon.src).toBe(true);
  }
});
