import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import WorkspaceIcon from './WorkspaceIcon';
import type { Project } from '../../state/chatTypes';

const project: Project = {
  id: 'p-test-123',
  name: 'capacity',
  chatIds: [],
  trees: [],
  edges: [],
  createdAt: 0,
} as unknown as Project;

describe('WorkspaceIcon', () => {
  it('renders nothing when mode=none', () => {
    const { container } = render(<WorkspaceIcon project={project} mode="none" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders badge with workspace letter when mode=badge', () => {
    const { getByText } = render(<WorkspaceIcon project={project} mode="badge" />);
    expect(getByText('C')).toBeTruthy();
  });
});
