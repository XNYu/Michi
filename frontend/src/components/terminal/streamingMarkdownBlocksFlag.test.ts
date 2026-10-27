import { beforeEach, describe, expect, it } from 'vitest';
import {
  STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY,
  streamingMarkdownBlocksEnabled,
} from './streamingMarkdownBlocksFlag';

describe('streamingMarkdownBlocksEnabled', () => {
  beforeEach(() => {
    window.localStorage.removeItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY);
  });

  it.each(['0', 'false', 'off'])('can be disabled by localStorage value %s', (value) => {
    window.localStorage.setItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY, value);

    expect(streamingMarkdownBlocksEnabled()).toBe(false);
  });
});
