// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { COMPOSER_COLLAPSED_ROWS, composerExceedsCollapsedRows } from './MentionEditor';

function makeEditorEl(scrollHeight: number, lineHeight = '20px') {
  const el = document.createElement('div');
  el.style.fontSize = '12px';
  el.style.lineHeight = lineHeight;
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 40 });
  document.body.appendChild(el);
  return el;
}

describe('composer overflow threshold', () => {
  it('does not exceed the collapsed threshold at exactly six rows', () => {
    const el = makeEditorEl(COMPOSER_COLLAPSED_ROWS * 20);
    expect(composerExceedsCollapsedRows(el)).toBe(false);
    el.remove();
  });

  it('exceeds the collapsed threshold once content passes six rows', () => {
    const el = makeEditorEl(COMPOSER_COLLAPSED_ROWS * 20 + 2);
    expect(composerExceedsCollapsedRows(el)).toBe(true);
    el.remove();
  });

  it('falls back to font size when the browser reports a non-pixel line height', () => {
    const el = makeEditorEl(COMPOSER_COLLAPSED_ROWS * 18 + 2, 'normal');
    el.style.fontSize = '12px';
    expect(composerExceedsCollapsedRows(el)).toBe(true);
    el.remove();
  });
});
