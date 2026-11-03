import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { DUR, EASE } from './tokens';

// Vitest stubs CSS imports (css: false), so index.css is read from disk.
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function token(name) {
  const value = css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1];
  if (!value) throw new Error(`index.css has no --${name}`);
  return value.trim();
}

function seconds(name) {
  const [, amount, unit] = token(name).match(/^([\d.]+)(ms|s)$/) ?? [];
  if (!amount) throw new Error(`--${name} is not a duration`);
  return unit === 'ms' ? Number(amount) / 1000 : Number(amount);
}

it('mirrors the CSS motion tokens in motion/tokens.ts', () => {
  for (const key of ['quick', 'soft', 'enter', 'exit', 'decay', 'slow']) {
    expect(DUR[key], `--t-${key}`).toBeCloseTo(seconds(`t-${key}`), 6);
  }
  const ease = token('t-ease').match(/cubic-bezier\(([^)]+)\)/)?.[1].split(',').map((n) => Number(n.trim()));
  expect(EASE.term).toEqual(ease);
});
