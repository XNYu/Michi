import { describe, expect, it } from 'vitest';
import type { ChatNodeState } from './chatTypes';
import {
  selectArchivedGroupCountForPage,
  selectTrashGroupCountForPage,
} from './topbarSelectors';

const nodes = {
  trashedA: { deletionGroupId: 'del-a' },
  trashedB: { deletionGroupId: 'del-a' },
  trashedC: { deletionGroupId: 'del-b' },
  archivedA: { deletionGroupId: 'arch-a' },
  archivedB: { deletionGroupId: 'arch-a' },
} satisfies Record<string, Pick<ChatNodeState, 'deletionGroupId'>>;

describe('topbar page count selectors', () => {
  it('does not inspect trash groups away from the trash page', () => {
    const throwingNodes = new Proxy(nodes, {
      ownKeys() {
        throw new Error('off-page selector walked the node map');
      },
    });

    expect(selectTrashGroupCountForPage('dashboard', throwingNodes)).toBe(0);
  });

  it('counts unique trash groups on the trash page', () => {
    expect(selectTrashGroupCountForPage('trash', nodes)).toBe(2);
  });

  it('does not inspect archived groups away from the archived page', () => {
    const throwingNodes = new Proxy(nodes, {
      ownKeys() {
        throw new Error('off-page selector walked the node map');
      },
    });

    expect(selectArchivedGroupCountForPage('dashboard', throwingNodes)).toBe(0);
  });

  it('counts unique archived groups on the archived page', () => {
    expect(selectArchivedGroupCountForPage('archived', nodes)).toBe(1);
  });
});
