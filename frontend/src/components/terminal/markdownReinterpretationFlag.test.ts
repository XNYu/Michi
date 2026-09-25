import { beforeEach, describe, expect, it } from 'vitest';
import {
  MARKDOWN_REINTERPRET_HZ_STORAGE_KEY,
  markdownReinterpretationHz,
} from './markdownReinterpretationFlag';

describe('markdownReinterpretationHz', () => {
  beforeEach(() => {
    window.localStorage.removeItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY);
  });

  it.each(['-1', '61', 'fast', 'Infinity'])('ignores invalid localStorage frequency %s', (value) => {
    window.localStorage.setItem(MARKDOWN_REINTERPRET_HZ_STORAGE_KEY, value);

    expect(markdownReinterpretationHz()).toBe(3);
  });
});
