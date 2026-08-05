// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StreamdownSnapshotTail from './StreamdownSnapshotTail';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('StreamdownSnapshotTail', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      await vi.dynamicImportSettled();
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  it('shows a styled Michi tail immediately and reparses it on the next snapshot', async () => {
    act(() => {
      root.render(
        <StreamdownSnapshotTail
          controls={false}
          linkSafety={{ enabled: false }}
          snapshotIntervalMs={333}
          streaming
          text="Hello"
        />,
      );
    });

    act(() => {
      root.render(
        <StreamdownSnapshotTail
          controls={false}
          linkSafety={{ enabled: false }}
          snapshotIntervalMs={333}
          streaming
          text="Hello **world"
        />,
      );
    });

    expect(container.querySelector('[data-markdown-snapshot-chars]')?.getAttribute('data-markdown-snapshot-chars')).toBe('5');
    expect(container.querySelector('strong')?.textContent).toBe('world');
    expect(container.textContent).not.toContain('**');

    await act(async () => {
      vi.advanceTimersByTime(333);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-markdown-snapshot-chars]')?.getAttribute('data-markdown-snapshot-chars')).toBe('13');
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('world');
  });

  it('keeps pending fenced-code text visible without changing Streamdown code extraction', async () => {
    const snapshot = '```ts\nconst a = 1;';
    const next = `${snapshot}\nconst b = 2;`;

    act(() => {
      root.render(
        <StreamdownSnapshotTail
          controls={false}
          linkSafety={{ enabled: false }}
          snapshotIntervalMs={333}
          streaming
          text={snapshot}
        />,
      );
    });
    act(() => {
      root.render(
        <StreamdownSnapshotTail
          controls={false}
          linkSafety={{ enabled: false }}
          snapshotIntervalMs={333}
          streaming
          text={next}
        />,
      );
    });

    expect(container.querySelector('code')?.textContent).toContain('const a = 1;');
    expect(container.textContent).toContain('const b = 2;');
    expect(container.querySelectorAll('[data-markdown-pending-tail]')).toHaveLength(1);
    expect(container.querySelector('[data-markdown-snapshot-chars]')?.getAttribute('data-markdown-snapshot-chars')).toBe(String(snapshot.length));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
  });

  it('mounts the pending tail only in the final Streamdown block', () => {
    act(() => {
      root.render(
        <StreamdownSnapshotTail
          controls={false}
          linkSafety={{ enabled: false }}
          snapshotIntervalMs={333}
          streaming
          text={'First paragraph\n\nSecond paragraph'}
        />,
      );
    });
    act(() => {
      root.render(
        <StreamdownSnapshotTail
          controls={false}
          linkSafety={{ enabled: false }}
          snapshotIntervalMs={333}
          streaming
          text={'First paragraph\n\nSecond paragraph tail'}
        />,
      );
    });

    expect(container.querySelectorAll('[data-markdown-pending-tail]')).toHaveLength(1);
    expect(container.textContent?.match(/ tail/g)).toHaveLength(1);
  });

  it('flushes non-append replacements immediately', () => {
    act(() => {
      root.render(
        <StreamdownSnapshotTail
          controls={false}
          linkSafety={{ enabled: false }}
          streaming
          text="Original"
        />,
      );
    });
    act(() => {
      root.render(
        <StreamdownSnapshotTail
          controls={false}
          linkSafety={{ enabled: false }}
          streaming
          text="Replacement"
        />,
      );
    });

    expect(container.querySelector('[data-markdown-snapshot-chars]')?.getAttribute('data-markdown-snapshot-chars')).toBe(String('Replacement'.length));
    expect(container.textContent).toContain('Replacement');
    expect(container.textContent).not.toContain('Original');
  });
});
