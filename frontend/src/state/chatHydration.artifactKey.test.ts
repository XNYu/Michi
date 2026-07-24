import { describe, expect, it } from 'vitest';
import { hydrateBackendWorkspaces } from './chatHydration';

// Regression guard for the wire-key mismatch that shipped once: the backend
// bulk loaders (`loadFullWorkspace`/`loadWorkspaceMeta`) emit artifact rows
// under the key `contexts`, but the frontend domain model renamed the concept
// to `artifacts`. When the hydrator only read `full.artifacts`, every restart
// silently dropped all artifacts (rows stayed in SQLite, UI showed none).
//
// These tests feed a RAW backend payload — the exact shape `fetchAllWorkspaces`
// hands to the hydrator — and assert the rows land in `project.artifacts`.
// The existing artifact fixtures are all `Project`-shaped (domain model), so
// none of them exercised this wire-key read; that gap is what let the bug ship.
describe('hydrateBackendWorkspaces artifact wire-key', () => {
  const workspace = { id: 'w1', name: 'WS', created_at: 1 };
  const contextRow = {
    id: 'ctx-1',
    name: 'notes',
    file_path: '/tmp/notes.md',
    type: 'file',
    source: 'user',
    created_at: 10,
    updated_at: 20,
  };

  it('restores artifacts from the backend `contexts` key', () => {
    const { projects } = hydrateBackendWorkspaces([{ workspace, contexts: [contextRow] }]);
    expect(projects).toHaveLength(1);
    expect(projects[0].artifacts!.map((a) => a.id)).toEqual(['ctx-1']);
    expect(projects[0].artifacts![0]).toMatchObject({ name: 'notes', filePath: '/tmp/notes.md', type: 'file' });
  });

  it('still accepts an `artifacts` key so a future wire-key alignment cannot re-break hydration', () => {
    const { projects } = hydrateBackendWorkspaces([{ workspace, artifacts: [contextRow] }]);
    expect(projects[0].artifacts!.map((a) => a.id)).toEqual(['ctx-1']);
  });

  it('restores link-type artifacts (url, no file_path) — the historical drop case', () => {
    const linkRow = { id: 'ctx-2', name: 'ref', url: 'https://example.com', type: 'link', created_at: 1, updated_at: 1 };
    const { projects } = hydrateBackendWorkspaces([{ workspace, contexts: [linkRow] }]);
    expect(projects[0].artifacts!.map((a) => a.id)).toEqual(['ctx-2']);
    expect(projects[0].artifacts![0]).toMatchObject({ type: 'link', url: 'https://example.com' });
  });

  it('prefers `contexts` when both keys are present', () => {
    const { projects } = hydrateBackendWorkspaces([
      { workspace, contexts: [contextRow], artifacts: [{ ...contextRow, id: 'stale' }] },
    ]);
    expect(projects[0].artifacts!.map((a) => a.id)).toEqual(['ctx-1']);
  });

  it('yields an empty artifact list when neither key is present', () => {
    const { projects } = hydrateBackendWorkspaces([{ workspace }]);
    expect(projects[0].artifacts!).toEqual([]);
  });
});
