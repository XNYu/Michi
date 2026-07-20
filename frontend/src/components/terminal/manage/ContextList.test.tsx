import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextList from './ContextList';
import type { ArtifactEntry } from '../../../state/chatTypes';

const NOW = 1_716_000_000_000;
const ctx = (
  id: string,
  name: string,
  opts: Partial<ArtifactEntry> = {},
): ArtifactEntry => ({
  id,
  name,
  filePath: `path/${name}`,
  size: 1024,
  type: 'doc',
  source: 'user',
  createdAt: NOW,
  updatedAt: NOW,
  ...opts,
});

function renderRow(props: Partial<React.ComponentProps<typeof ContextList>> = {}) {
  return render(
    <ContextList
      artifacts={[ctx('1', 'a.md')]}
      filter=""
      selectedContextId={null}
      onSelect={() => {}}
      onPin={() => {}}
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
  it('groups artifacts by type (Documents / Files / Images / Links)', () => {
    render(
      <ContextList
        artifacts={[
          ctx('1', 'a.md', { type: 'doc' }),
          ctx('2', 'b.ts', { type: 'file' }),
          ctx('3', 'diagram', { type: 'image' }),
          ctx('4', 'stripe-api', { type: 'link', filePath: '', url: 'https://stripe.com' }),
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
    expect(screen.getByText(/documents/i)).not.toBeNull();
    expect(screen.getByText(/^files/i)).not.toBeNull();
    expect(screen.getByText(/images/i)).not.toBeNull();
    expect(screen.getByText(/links/i)).not.toBeNull();
    // Link row renders its url as the meta line.
    expect(screen.queryByText('https://stripe.com')).not.toBeNull();
  });

  it('sorts favorite artifacts to the top of their group', () => {
    render(
      <ContextList
        artifacts={[
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
      artifacts: [ctx('1', 'a.md', { pinnedAt: NOW })],
      onPin,
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
      artifacts: [ctx('1', 'a.md')],
      onDelete,
    });
    hoverFirstRow();
    fireEvent.click(screen.getByLabelText(/delete a\.md/i));
    expect(onDelete).toHaveBeenCalledWith('1');
  });

  it('hover reveals the preview button; clicking it calls onPreview with the file path', () => {
    const onPreview = vi.fn();
    renderRow({
      artifacts: [ctx('1', 'a.md')],
      onPreview,
    });
    hoverFirstRow();
    fireEvent.click(screen.getByLabelText(/preview a\.md/i));
    expect(onPreview).toHaveBeenCalledWith('path/a.md');
  });

  it('filter hides non-matching artifacts', () => {
    render(
      <ContextList
        artifacts={[ctx('1', 'apples.md'), ctx('2', 'bananas.md')]}
        filter="app"
        selectedContextId={null}
        onSelect={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onPreview={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.queryByText('apples.md')).not.toBeNull();
    expect(screen.queryByText('bananas.md')).toBeNull();
  });
});
