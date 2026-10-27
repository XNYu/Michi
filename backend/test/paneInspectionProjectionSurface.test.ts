import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { surfaceToDescriptor, type SurfaceProjectionInput, type SurfacePaneKind } from '../src/services/paneInspectionProjection.surface';

// ---------------------------------------------------------------------------
// Fixture builder — plain object, no DB, no presence registry.
// ---------------------------------------------------------------------------

function baseInput(kind: SurfacePaneKind, overrides: Partial<SurfaceProjectionInput> = {}): SurfaceProjectionInput {
  return {
    registrationId: 'reg-1',
    kind,
    workspaceId: 'ws-1',
    treeId: 'tree-1',
    rendererTitle: null,
    presence: { coverage: 'unknown', views: [] },
    backendConnectionId: 'conn-1',
    observedAt: 1_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Renderer-supplied title is passed through, never interpreted
// ---------------------------------------------------------------------------

describe('surfaceToDescriptor — renderer-supplied title', () => {
  it('is passed through verbatim when present', () => {
    const descriptor = surfaceToDescriptor(baseInput('terminal', { rendererTitle: 'My terminal' }));
    assert.equal(descriptor.title, 'My terminal');
  });
});
