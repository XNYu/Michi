import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextList from './ContextList';
import type { ContextEntry } from '../../../state/chatTypes';

const NOW = 1_716_000_000_000;
const ctx = (id: string, name: string, autoInject: boolean): ContextEntry => ({
  id,
  name,
  filePath: `path/${name}`,
  size: 1024,
  autoInject,
  source: 'user',
  createdAt: NOW,
  updatedAt: NOW,
});

function renderRow(props: Partial<React.ComponentProps<typeof ContextList>> = {}) {
  return render(
    <ContextList
      contexts={[ctx('1', 'a.md', false)]}
      filter=""
      selectedContextId={null}
      onSelect={() => {}}
      onToggleAutoInject={() => {}}
      onDelete={() => {}}
      onPreview={() => {}}
      onAdd={() => {}}
      {...props}
    />,
  );
}

function hoverFirstRow() {
  const row = screen.getByText('a.md').closest('[data-hovered]') as HTMLElement;
  fireEvent.mouseEnter(row);
  return row;
}

describe('ContextList', () => {
  it('splits into Auto-injecting and Available groups', () => {
    render(
      <ContextList
        contexts={[ctx('1', 'a.md', true), ctx('2', 'b.md', false)]}
        filter=""
        selectedContextId={null}
        onSelect={() => {}}
        onToggleAutoInject={() => {}}
        onDelete={() => {}}
        onPreview={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText(/auto-injecting/i).parentElement?.textContent).toContain('1');
    expect(screen.getByText(/^available/i).parentElement?.textContent).toContain('1');
  });

  it('hover reveals the pin button; clicking it calls onToggleAutoInject with the negated value', () => {
    const onToggle = vi.fn();
    renderRow({
      contexts: [ctx('1', 'a.md', true)],
      onToggleAutoInject: onToggle,
    });
    hoverFirstRow();
    fireEvent.click(screen.getByLabelText(/unpin a\.md/i));
    expect(onToggle).toHaveBeenCalledWith('1', false);
  });

  it('hover reveals the trash button; clicking it calls onDelete', () => {
    const onDelete = vi.fn();
    renderRow({
      contexts: [ctx('1', 'a.md', false)],
      onDelete,
    });
    hoverFirstRow();
    fireEvent.click(screen.getByLabelText(/delete a\.md/i));
    expect(onDelete).toHaveBeenCalledWith('1');
  });

  it('hover reveals the preview button; clicking it calls onPreview with the file path', () => {
    const onPreview = vi.fn();
    renderRow({
      contexts: [ctx('1', 'a.md', false)],
      onPreview,
    });
    hoverFirstRow();
    fireEvent.click(screen.getByLabelText(/preview a\.md/i));
    expect(onPreview).toHaveBeenCalledWith('path/a.md');
  });

  it('filter hides non-matching contexts', () => {
    render(
      <ContextList
        contexts={[ctx('1', 'apples.md', false), ctx('2', 'bananas.md', false)]}
        filter="app"
        selectedContextId={null}
        onSelect={() => {}}
        onToggleAutoInject={() => {}}
        onDelete={() => {}}
        onPreview={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.queryByText('apples.md')).not.toBeNull();
    expect(screen.queryByText('bananas.md')).toBeNull();
  });
});
