import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PermissionBanner from './PermissionBanner';

describe('PermissionBanner source label', () => {
  it('renders Codex approval source', () => {
    render(
      <PermissionBanner
        permission={{
          requestId: 1,
          title: 'Approve bash?',
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
          source: 'codex_approval',
        }}
        onRespond={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByTestId('permission-source').textContent).toBe('Codex approval');
  });
});
