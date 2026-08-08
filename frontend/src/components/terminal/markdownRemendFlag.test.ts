import { beforeEach, describe, expect, it } from 'vitest';
import {
  MARKDOWN_REMEND_STORAGE_KEY,
  markdownRemendEnabled,
} from './markdownRemendFlag';

describe('markdownRemendEnabled', () => {
  beforeEach(() => {
    window.localStorage.removeItem(MARKDOWN_REMEND_STORAGE_KEY);
  });

  it('defaults to enabled', () => {
    expect(markdownRemendEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'off'])('honors kill-switch value %s', (value) => {
    window.localStorage.setItem(MARKDOWN_REMEND_STORAGE_KEY, value);

    expect(markdownRemendEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'on'])('honors explicit enable value %s', (value) => {
    window.localStorage.setItem(MARKDOWN_REMEND_STORAGE_KEY, value);

    expect(markdownRemendEnabled()).toBe(true);
  });
});
