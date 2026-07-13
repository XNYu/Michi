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

  it('sorts favorite artifacts to the top of their group', () => {
    render(
      <ContextList
        contexts={[
          ctx('1', 'older.md', { createdAt: NOW }),
          ctx('2', 'favorite.md', { createdAt: NOW - 1000, pinnedAt: NOW }),
        ]}
        filter=""
        selectedContextId={null}
        onSelect={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onPreview={() => {}}
        onAdd={() => {}}
      />,
    );
    const names = screen.getAllByText(/\.md$/).map((n) => n.textContent);
    expect(names[0]).toBe('favorite.md');
  });

  it('describes a favorite as removable without implying auto-injection', () => {
    const onPin = vi.fn();
    renderRow({
      contexts: [ctx('1', 'a.md', true)],
      onToggleAutoInject: onToggle,
    });
    hoverFirstRow();
    const favoriteButton = screen.getByRole('button', { name: 'Remove a.md from favorites' });
    expect(favoriteButton.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(favoriteButton);
    expect(onPin).toHaveBeenCalledWith('1');
  });

  it('offers to add a non-favorite artifact to favorites', () => {
    renderRow();
    hoverFirstRow();
    const favoriteButton = screen.getByRole('button', { name: 'Add a.md to favorites' });
    expect(favoriteButton.getAttribute('aria-pressed')).toBe('false');
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
