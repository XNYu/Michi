import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('defines a container-driven select fallback without a clipped horizontal settings tab row', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Settings.css'), 'utf8');
  expect(css).toContain('container-type: inline-size');
  expect(css).toContain('grid-template-columns: 156px minmax(0, 1fr)');
  expect(css).toContain('@container (max-width: 540px)');
  expect(css).toMatch(/\.terminal-settings-categories\s*\{\s*display: none/);
  expect(css).toMatch(/\.terminal-settings-select\s*\{\s*display: flex/);
  expect(css).not.toContain('white-space: nowrap');
});
