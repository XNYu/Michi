import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { ComposerShell } from './ComposerShell';

describe('ComposerShell', () => {
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
