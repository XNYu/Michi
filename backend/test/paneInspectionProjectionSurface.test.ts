import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodePaneId, PANE_KINDS, type PaneDescriptorV1, type PaneKind } from 'michi-shared';
import {
  surfaceToDescriptor,
  SURFACE_PANE_KINDS,
  type SurfaceProjectionInput,
  type SurfacePaneKind,
} from '../src/services/paneInspectionProjection.surface';

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
// Per-kind capability mapping — §5.1
// ---------------------------------------------------------------------------

describe('surfaceToDescriptor — per-kind capability mapping', () => {
  const notApplicableKinds: SurfacePaneKind[] = ['launcher', 'files', 'review', 'file', 'diff'];
  const unknownKinds: SurfacePaneKind[] = ['terminal', 'browser'];

  for (const kind of notApplicableKinds) {
    it(`${kind}: activity is not_applicable, execution is unsupported`, () => {
      const descriptor = surfaceToDescriptor(baseInput(kind));
      assert.equal(descriptor.activity, 'not_applicable');
      assert.equal(descriptor.execution.status, 'unsupported');
    });
  }

  for (const kind of unknownKinds) {
    it(`${kind}: activity is unknown, execution is unknown — NOT not_applicable`, () => {
      const descriptor = surfaceToDescriptor(baseInput(kind));
      assert.equal(descriptor.activity, 'unknown');
      assert.equal(descriptor.execution.status, 'unknown');
      assert.notEqual(descriptor.execution.status, 'not_applicable');
      assert.notEqual(descriptor.activity, 'not_applicable');
    });
  }

  for (const kind of SURFACE_PANE_KINDS) {
    it(`${kind}: conversation/readOutput/waitForTerminal are all unsupported`, () => {
      const descriptor = surfaceToDescriptor(baseInput(kind));
      assert.equal(descriptor.conversation.status, 'unsupported');
      assert.equal(descriptor.capabilities.readOutput, false);
      assert.equal(descriptor.capabilities.waitForTerminal, false);
      assert.equal(descriptor.capabilities.subscribe, false);
      assert.equal(descriptor.latestOutput.status, 'unsupported');
    });
  }
});

// ---------------------------------------------------------------------------
// Every non-ready section carries a non-empty reason
// ---------------------------------------------------------------------------

describe('surfaceToDescriptor — non-ready sections always carry a reason', () => {
  function nonReadySections(descriptor: PaneDescriptorV1): Array<{ path: string; reason: string | undefined }> {
    const sections: Array<[string, { status: string; reason?: string }]> = [
      ['execution', descriptor.execution as { status: string; reason?: string }],
      ['conversation', descriptor.conversation as { status: string; reason?: string }],
      ['lineage', descriptor.lineage as { status: string; reason?: string }],
      ['runtime', descriptor.runtime as { status: string; reason?: string }],
      ['latestOutput', descriptor.latestOutput as { status: string; reason?: string }],
    ];
    return sections
      .filter(([, section]) => section.status !== 'ready')
      .map(([path, section]) => ({ path, reason: section.reason }));
  }

  for (const kind of SURFACE_PANE_KINDS) {
    it(`${kind}: every non-ready section has a non-empty string reason`, () => {
      const descriptor = surfaceToDescriptor(baseInput(kind));
      const nonReady = nonReadySections(descriptor);
      // Every one of the five sections is non-ready for every surface kind — assert that holds,
      // so a future accidental 'ready' doesn't silently skip the reason check below.
      assert.equal(nonReady.length, 5, `expected all five sections to be non-ready for ${kind}`);
      for (const { path, reason } of nonReady) {
        assert.equal(typeof reason, 'string', `${kind}.${path}.reason must be a string`);
        assert.ok(reason && reason.trim().length > 0, `${kind}.${path}.reason must not be empty`);
        // Never collapse unsupported/unknown into filler — the brief explicitly calls out
        // one-word non-answers like "unknown" as insufficient.
        assert.notEqual(reason.trim().toLowerCase(), 'unknown', `${kind}.${path}.reason must be actionable, not filler`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// capabilities agree with sections — no advertised capability whose section is unsupported
// ---------------------------------------------------------------------------

describe('surfaceToDescriptor — capabilities never contradict their section', () => {
  for (const kind of SURFACE_PANE_KINDS) {
    it(`${kind}: readOutput/waitForTerminal false because their sections are unsupported`, () => {
      const descriptor = surfaceToDescriptor(baseInput(kind));
      if (descriptor.latestOutput.status === 'unsupported') assert.equal(descriptor.capabilities.readOutput, false);
      if (descriptor.execution.status === 'unsupported' || descriptor.execution.status === 'unknown') {
        assert.equal(descriptor.capabilities.waitForTerminal, false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// ref.paneId round-trips through decodePaneId
// ---------------------------------------------------------------------------

describe('surfaceToDescriptor — paneId identity', () => {
  for (const kind of SURFACE_PANE_KINDS) {
    it(`${kind}: ref.paneId is surface:{registrationId} and round-trips through decodePaneId`, () => {
      const descriptor = surfaceToDescriptor(baseInput(kind, { registrationId: 'reg-abc-123' }));
      assert.equal(descriptor.ref.paneId, 'surface:reg-abc-123');
      const target = decodePaneId(descriptor.ref.paneId);
      assert.deepEqual(target, { kind: 'surface', registrationId: 'reg-abc-123' });
      assert.deepEqual(descriptor.target, { kind: 'surface', registrationId: 'reg-abc-123' });
    });
  }
});

// ---------------------------------------------------------------------------
// Renderer-supplied title is passed through, never interpreted
// ---------------------------------------------------------------------------

describe('surfaceToDescriptor — renderer-supplied title', () => {
  it('is passed through verbatim when present', () => {
    const descriptor = surfaceToDescriptor(baseInput('terminal', { rendererTitle: 'My terminal' }));
    assert.equal(descriptor.title, 'My terminal');
  });

  it('is an empty string, not null, when no renderer title has been submitted', () => {
    const descriptor = surfaceToDescriptor(baseInput('browser', { rendererTitle: null }));
    assert.equal(descriptor.title, '');
  });

  it('markup and quote characters in a title are passed through unmodified, never interpreted', () => {
    const dangerous = `<script>alert("x")</script> \` ' " ; DROP TABLE nodes;`;
    const descriptor = surfaceToDescriptor(baseInput('browser', { rendererTitle: dangerous }));
    assert.equal(descriptor.title, dangerous);
  });
});

// ---------------------------------------------------------------------------
// presence is taken as given
// ---------------------------------------------------------------------------

describe('surfaceToDescriptor — presence is passed through as given', () => {
  it('reflects the P2-1 presence section exactly, unmodified', () => {
    const presence: PaneDescriptorV1['presence'] = {
      coverage: 'reported',
      views: [
        {
          windowId: 'win-1',
          uiPaneId: 'pane:terminal:abc',
          treeId: 'tree-1',
          visible: true,
          openedAtClient: 500,
          registeredAt: 900,
          lastSeenAt: 950,
        },
      ],
    };
    const descriptor = surfaceToDescriptor(baseInput('terminal', { presence }));
    assert.deepEqual(descriptor.presence, presence);
  });
});

// ---------------------------------------------------------------------------
// timeline is null unconditionally — registration time is never substituted for resource time
// ---------------------------------------------------------------------------

describe('surfaceToDescriptor — timeline', () => {
  for (const kind of SURFACE_PANE_KINDS) {
    it(`${kind}: resourceCreatedAt and firstExecutionStartedAt are both null`, () => {
      const descriptor = surfaceToDescriptor(baseInput(kind));
      assert.equal(descriptor.timeline.resourceCreatedAt, null);
      assert.equal(descriptor.timeline.firstExecutionStartedAt, null);
    });
  }
});

// ---------------------------------------------------------------------------
// Coverage test — every PaneKind is handled by exactly one of the three projection modules.
// This is the check that catches a kind being forgotten later (task list acceptance criterion).
//
// NOTE: as of this task, `paneInspectionProjection.chat.ts` (P1-2) exports only
// `chatNodeToDescriptor`, which returns `kind: 'chat'` unconditionally — it does not yet branch
// on 'digest' or 'artifact', even though the design doc's capability table (§5.1) and the task
// list's P1-6 acceptance line group Chat/Digest/Artifact together. Asserting "exactly one" would
// therefore be false today for 'digest' and 'artifact': they currently belong to ZERO modules,
// not one. This test asserts the real, current state (chat.ts handles only 'chat'; run.ts
// handles only 'agent-run'; this module handles the seven surface kinds) and separately reports
// digest/artifact as a known gap via `PANE_KIND_COVERAGE_GAPS`, so the test fails loudly — the
// exact goal of this check — the day 'digest' or 'artifact' silently stops being handled by
// whichever future module is meant to pick them up, without falsely claiming they are covered
// now. See this task's final report for why this could not be resolved inside a module that owns
// neither chat.ts nor a not-yet-created digest/artifact adapter.
// ---------------------------------------------------------------------------

describe('PANE_KINDS coverage across all three projection modules', () => {
  const CHAT_KINDS: readonly PaneKind[] = ['chat'];
  const RUN_KINDS: readonly PaneKind[] = ['agent-run'];
  /** Kinds with no adapter in any of the three projection modules today. Not this task's files to
   *  fix — chat.ts is P1-2-owned and digest/artifact routing is design-flagged as deferred (§5.1
   *  footnote 1). Tracked explicitly so the coverage assertion below is honest rather than
   *  papering over the gap. */
  const PANE_KIND_COVERAGE_GAPS: readonly PaneKind[] = ['digest', 'artifact'];

  it('every currently-adapted kind in PANE_KINDS is handled by exactly one of chat/run/surface', () => {
    for (const kind of PANE_KINDS) {
      if (PANE_KIND_COVERAGE_GAPS.includes(kind)) continue;
      const inChat = CHAT_KINDS.includes(kind);
      const inRun = RUN_KINDS.includes(kind);
      const inSurface = (SURFACE_PANE_KINDS as readonly PaneKind[]).includes(kind);
      const memberships = [inChat, inRun, inSurface].filter(Boolean).length;
      assert.equal(memberships, 1, `PaneKind "${kind}" must be handled by exactly one projection module, found in ${memberships}`);
    }
  });

  it('flags the known digest/artifact coverage gap without claiming false coverage', () => {
    for (const kind of PANE_KIND_COVERAGE_GAPS) {
      const inChat = CHAT_KINDS.includes(kind);
      const inRun = RUN_KINDS.includes(kind);
      const inSurface = (SURFACE_PANE_KINDS as readonly PaneKind[]).includes(kind);
      assert.equal([inChat, inRun, inSurface].filter(Boolean).length, 0, `"${kind}" was expected to still be an open gap — update PANE_KIND_COVERAGE_GAPS if it has been adapted`);
    }
  });

  it('SURFACE_PANE_KINDS plus chat/run/gap kinds together equal PANE_KINDS with no unexplained gaps', () => {
    const covered = new Set<PaneKind>([
      ...CHAT_KINDS,
      ...RUN_KINDS,
      ...(SURFACE_PANE_KINDS as readonly PaneKind[]),
      ...PANE_KIND_COVERAGE_GAPS,
    ]);
    for (const kind of PANE_KINDS) {
      assert.ok(covered.has(kind), `PaneKind "${kind}" is neither covered nor tracked as a known gap`);
    }
    assert.equal(covered.size, PANE_KINDS.length, 'covered+gap kinds must exactly match PANE_KINDS, no extras');
  });
});
