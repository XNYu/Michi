import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantAttachmentsPreBlock } from './AssistantAttachments';
import {
  addAssistantAttachments,
  getAssistantComposer,
  resetAssistantComposerForTests,
} from '../../../state/assistant/assistantComposer';

afterEach(() => act(() => resetAssistantComposerForTests()));

describe('AssistantAttachmentsPreBlock', () => {
  it('renders nothing without attachments', () => {
    const { container } = render(<AssistantAttachmentsPreBlock nodeId="a" />);
    expect(container.innerHTML).toBe('');
  });

  it('shows a chip per item, folds past three into +N, and × removes one', () => {
    act(() => addAssistantAttachments('a', [
      { kind: 'thread', id: 't7', title: 'S7 · 迁移 MCP 配置' },
      { kind: 'block', id: 'b1', title: 'Plan vs actual' },
      { kind: 'row', id: 'r1', title: 'Two hotels' },
      { kind: 'thread', id: 't8', title: 'S8' },
      { kind: 'node', id: 'n1', title: 'Fix CI' },
    ]));
    render(<AssistantAttachmentsPreBlock nodeId="a" />);
    expect(screen.getByText('Thread · S7 · 迁移 MCP 配置')).toBeTruthy();
    expect(screen.getByText('Block · Plan vs actual')).toBeTruthy();
    expect(screen.getByText('Row · Two hotels')).toBeTruthy();
    expect(screen.queryByText('Thread · S8')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }));
    expect(screen.getByText('Thread · S8')).toBeTruthy();
    expect(screen.getByText('Thread · Fix CI')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Block · Plan vs actual' }));
    expect(getAssistantComposer('a').attachments.map((i) => i.id)).toEqual(['t7', 'r1', 't8', 'n1']);
    expect(screen.queryByText('Block · Plan vs actual')).toBeNull();
  });
});
