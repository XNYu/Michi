import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('always shows the sidebar navigation without a select fallback', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Settings.css'), 'utf8');
  expect(css).toContain('container-type: inline-size');
  expect(css).toContain('grid-template-columns: 156px minmax(0, 1fr)');
  expect(css).not.toMatch(/\.terminal-settings-categories\s*\{\s*display: none/);
  expect(css).not.toMatch(/\.terminal-settings-select/);
});
