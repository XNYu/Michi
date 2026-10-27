import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'michiHome.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The element each rule applies to: the last compound selector, minus its :has()/:not()/:is() arguments. */
function subjectsOf(selectorList) {
  let flat = selectorList;
  while (/\([^()]*\)/.test(flat)) flat = flat.replace(/\([^()]*\)/g, '');
  return flat.split(',').map((selector) => selector.trim().split(/[\s>+~]+/).pop());
}

it('never hides a Home row control with display: none or visibility: hidden', () => {
  // Showing a control only while the row has focus, then removing it while
  // focus moves onto it, sends focus to <body>: rows clip at rest instead.
  const hidden = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => /display:\s*none|visibility:\s*hidden/.test(body))
    .flatMap(([, selectors]) => subjectsOf(selectors));
  expect(hidden.length).toBeGreaterThan(0);
  const controls = /__(actions|inline-meta|sub|open|check|confirm|project|icon|restore)\b|michi-continue/;
  expect(hidden.filter((subject) => controls.test(subject))).toEqual([]);
});

it('lights a row and shows its actions for keyboard focus, not for a mouse click that left focus behind', () => {
  expect(css).toContain('.michi-home-row:has(:focus-visible)');
  expect(css).toContain('.michi-home-row:not(:hover):not(:has(:focus-visible))');
  expect(css).not.toMatch(/\.michi-home-row:focus-within|\.michi-home-row:is\([^)]*:focus-within/);
});
