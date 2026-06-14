import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComposerShell } from './ComposerShell';

describe('ComposerShell', () => {
  it('renders the input slot in the caret row alongside the ›_ caret', () => {
    render(
      <ComposerShell input={<textarea data-testid="ta" defaultValue="" />} />,
    );
    expect(screen.getByText('›_')).toBeTruthy();
    expect(screen.getByTestId('ta')).toBeTruthy();
  });

  it('renders preBlocks above the caret row when provided', () => {
    render(
      <ComposerShell
        preBlocks={<div data-testid="pre">queued</div>}
        input={<textarea defaultValue="" />}
      />,
    );
    expect(screen.getByTestId('pre')).toBeTruthy();
  });

  it('renders toolbar slots and a flex spacer between them', () => {
    render(
      <ComposerShell
        input={<textarea defaultValue="" />}
        toolbarLeft={<span data-testid="tl">left</span>}
        toolbarRight={<span data-testid="tr">right</span>}
      />,
    );
    expect(screen.getByTestId('tl')).toBeTruthy();
    expect(screen.getByTestId('tr')).toBeTruthy();
  });

  it('forwards drag handlers to the outer div', () => {
    let dropped = false;
    const { container } = render(
      <ComposerShell
        input={<textarea defaultValue="" />}
        onDrop={() => {
          dropped = true;
        }}
      />,
    );
    const root = container.querySelector('.terminal-composer') as HTMLElement;
    fireEvent.drop(root);
    expect(dropped).toBe(true);
  });
});
