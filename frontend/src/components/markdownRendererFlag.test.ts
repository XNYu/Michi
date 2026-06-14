import { beforeEach, describe, expect, it } from 'vitest';
import {
  MARKDOWN_RENDERER_CHANGE_EVENT,
  MARKDOWN_RENDERER_STORAGE_KEY,
  normalizeMarkdownRenderer,
  readMarkdownRendererFlag,
  setMarkdownRendererFlag,
} from './markdownRendererFlag';

describe('markdown renderer feature flag', () => {
  beforeEach(() => {
    window.localStorage.removeItem(MARKDOWN_RENDERER_STORAGE_KEY);
  });

  it('defaults to the legacy renderer', () => {
    expect(readMarkdownRendererFlag()).toBe('react-markdown');
  });

  it('reads a valid localStorage override', () => {
    window.localStorage.setItem(MARKDOWN_RENDERER_STORAGE_KEY, 'streamdown');

    expect(readMarkdownRendererFlag()).toBe('streamdown');
  });

  it('ignores invalid values', () => {
    window.localStorage.setItem(MARKDOWN_RENDERER_STORAGE_KEY, 'surprise');

    expect(readMarkdownRendererFlag()).toBe('react-markdown');
    expect(normalizeMarkdownRenderer('surprise')).toBeNull();
  });

  it('announces runtime changes in the current window', () => {
    let fired = false;
    window.addEventListener(MARKDOWN_RENDERER_CHANGE_EVENT, () => {
      fired = true;
    }, { once: true });

    setMarkdownRendererFlag('streamdown');

    expect(fired).toBe(true);
    expect(readMarkdownRendererFlag()).toBe('streamdown');
  });
});

