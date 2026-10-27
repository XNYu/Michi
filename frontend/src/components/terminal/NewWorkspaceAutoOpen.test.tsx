import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { NewWorkspaceAutoOpen } from './NewWorkspaceAutoOpen';

describe('NewWorkspaceAutoOpen', () => {
  it('opens once when ready', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<NewWorkspaceAutoOpen ready onOpen={onOpen} />);
    rerender(<NewWorkspaceAutoOpen ready onOpen={onOpen} />);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('waits until ready', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<NewWorkspaceAutoOpen ready={false} onOpen={onOpen} />);
    expect(onOpen).not.toHaveBeenCalled();
    rerender(<NewWorkspaceAutoOpen ready onOpen={onOpen} />);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('does not open again after the user had no workspace and then got one', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<NewWorkspaceAutoOpen ready onOpen={onOpen} />);
    rerender(<NewWorkspaceAutoOpen ready={false} onOpen={onOpen} />);
    rerender(<NewWorkspaceAutoOpen ready onOpen={onOpen} />);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
