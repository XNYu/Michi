import { beforeEach, describe, expect, it } from 'vitest';
import {
  MARKDOWN_REINTERPRET_HZ_STORAGE_KEY,
  markdownReinterpretationHz,
} from './markdownReinterpretationFlag';

describe('markdownReinterpretationHz', () => {
  beforeEach(() => {
    window.localStorage.removeItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY);
  });

  it('defaults to three semantic refreshes per second', () => {
    expect(markdownReinterpretationHz()).toBe(3);
  });

  it.each(['0', '1', '20', '60'])('accepts localStorage frequency %s', (value) => {
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, value);

    expect(markdownReinterpretationHz()).toBe(Number(value));
  });

  it.each(['-1', '61', 'fast', 'Infinity'])('ignores invalid localStorage frequency %s', (value) => {
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, value);

    expect(markdownReinterpretationHz()).toBe(3);
  });
});
