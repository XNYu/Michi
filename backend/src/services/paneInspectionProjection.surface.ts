/**
 * Surface adapter: projects already-fetched surface-registration inputs into a PaneDescriptorV1
 * for the seven pane kinds that have no persistent backing object — `launcher`, `files`,
 * `review`, `file`, `diff`, `terminal`, `browser`.
 *
 * PURE MODULE — no database access, no presence registry calls, no `Date.now()`. Every clock
 * reading the caller may need (`observedAt`) is injected, matching the two sibling adapters
 * (`paneInspectionProjection.chat.ts`, `paneInspectionProjection.run.ts`).
 *
 * Design: docs/pane-inspection-api-design-2026-09-14.md §5.1 (capability matrix), §4.2 (view
 * identity for panes with no persistent object), §5 (Section<T> rules).
 */

import {
  encodePaneId,
  type PaneDescriptorV1,
  type PaneKind,
  type Section,
} from 'michi-shared';

// ---------------------------------------------------------------------------
// Input shape
// ---------------------------------------------------------------------------

/** The seven kinds this adapter owns. A `PaneKind` outside this set is a caller bug — see
 *  `SURFACE_PANE_KINDS` below, which is what the coverage test walks against `PANE_KINDS`. */
export type SurfacePaneKind = 'launcher' | 'files' | 'review' | 'file' | 'diff' | 'terminal' | 'browser';

export const SURFACE_PANE_KINDS: readonly SurfacePaneKind[] = [
  'launcher', 'files', 'review', 'file', 'diff', 'terminal', 'browser',
];

export interface SurfaceProjectionInput {
  /** The server-allocated short-lived registration id (see panePresence.ts
   *  `allocateSurfaceRegistration`). Identity comes from this, never from anything the renderer
   *  asserts. */
  registrationId: string;
  kind: SurfacePaneKind;
  workspaceId: string;
  treeId: string | null;
  /** Renderer-supplied title, stored and returned verbatim as renderer-provided data. It is
   *  never treated as fact, never used for authorisation, and never interpreted or reformatted —
   *  a title containing markup or a quote character is passed through exactly as given. */
  rendererTitle: string | null;
  /** §2-1 supplies this; accepted as given, never computed here. */
  presence: PaneDescriptorV1['presence'];
  backendConnectionId: string;
  /** Injected clock reading. Never read Date.now() inside this module. */
  observedAt: number;
}

// ---------------------------------------------------------------------------
// §5.1 per-kind capability mapping
// ---------------------------------------------------------------------------

/** launcher/files/review: the concept of "execution" genuinely does not apply — these are pure
 *  UI surfaces with nothing that runs. `not_applicable` is correct here per §5.1's own rule:
 *  it is a positive claim that the concept does not apply. */
const NOT_APPLICABLE_EXECUTION_KINDS: ReadonlySet<SurfacePaneKind> = new Set(['launcher', 'files', 'review', 'file', 'diff']);

/** terminal/browser: a terminal may have a live process and a browser a loading page — the
 *  window existing tells us nothing about it, and §5.1 forbids inferring process state from
 *  window presence. This is `unknown`, never `not_applicable`: `not_applicable` would assert
 *  these kinds never execute, which is false. */
const UNKNOWN_EXECUTION_KINDS: ReadonlySet<SurfacePaneKind> = new Set(['terminal', 'browser']);

const EXECUTION_REASON: Record<SurfacePaneKind, string> = {
  launcher: 'launcher panes are a UI chooser with nothing that executes',
  files: 'the files browser pane has no execution concept',
  review: 'the review pane has no execution concept',
  file: 'file viewer panes do not execute; use the existing file-read APIs for content',
  diff: 'diff viewer panes do not execute; use the existing file-read APIs for content',
  terminal: 'terminal process state is not observable in this release; a window existing does not imply a live or dead process',
  browser: 'browser page/navigation state is not observable in this release; a window existing does not imply a loaded or loading page',
};

const CONVERSATION_UNSUPPORTED_REASON: Record<SurfacePaneKind, string> = {
  launcher: 'launcher panes have no conversation model',
  files: 'the files browser pane has no conversation model',
  review: 'the review pane has no conversation model',
  file: 'file viewer panes have no conversation model',
  diff: 'diff viewer panes have no conversation model',
  terminal: 'terminal panes have no conversation model',
  browser: 'browser panes have no conversation model',
};

const LINEAGE_UNSUPPORTED_REASON: Record<SurfacePaneKind, string> = {
  launcher: 'launcher panes have no persistent object to derive lineage from',
  files: 'the files browser pane has no persistent object to derive lineage from',
  review: 'the review pane has no persistent object to derive lineage from',
  file: 'file viewer panes have no persistent object to derive lineage from',
  diff: 'diff viewer panes have no persistent object to derive lineage from',
  terminal: 'terminal panes have no persistent object to derive lineage from',
  browser: 'browser panes have no persistent object to derive lineage from',
};

const RUNTIME_UNSUPPORTED_REASON: Record<SurfacePaneKind, string> = {
  launcher: 'launcher panes have no runtime profile',
  files: 'the files browser pane has no runtime profile',
  review: 'the review pane has no runtime profile',
  file: 'file viewer panes have no runtime profile',
  diff: 'diff viewer panes have no runtime profile',
  terminal: 'terminal panes have no runtime profile',
  browser: 'browser panes have no runtime profile',
};

const LATEST_OUTPUT_UNSUPPORTED_REASON: Record<SurfacePaneKind, string> = {
  launcher: 'launcher panes produce no output',
  files: 'the files browser pane produces no output',
  review: 'the review pane produces no output',
  file: 'file viewer panes produce no output distinct from file content; use the existing file-read APIs',
  diff: 'diff viewer panes produce no output distinct from file content; use the existing file-read APIs',
  terminal: 'terminal output is not exposed by this API in this release; readOutput/waitForTerminal remain unsupported',
  browser: 'browser page content is not exposed by this API in this release',
};

function executionSection(kind: SurfacePaneKind): Section<null> {
  if (NOT_APPLICABLE_EXECUTION_KINDS.has(kind)) {
    return { status: 'unsupported', reason: EXECUTION_REASON[kind] };
  }
  // UNKNOWN_EXECUTION_KINDS — the only remaining member of SurfacePaneKind by construction.
  return { status: 'unknown', reason: EXECUTION_REASON[kind] };
}

function activityFor(kind: SurfacePaneKind): PaneDescriptorV1['activity'] {
  return NOT_APPLICABLE_EXECUTION_KINDS.has(kind) ? 'not_applicable' : 'unknown';
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

export function surfaceToDescriptor(input: SurfaceProjectionInput): PaneDescriptorV1 {
  const { registrationId, kind, workspaceId, treeId, rendererTitle, presence, backendConnectionId, observedAt } = input;

  return {
    version: 1,
    ref: { backendConnectionId, paneId: encodePaneId({ kind: 'surface', registrationId }) },
    target: { kind: 'surface', registrationId },
    kind: kind as PaneKind,
    // Renderer-supplied title, passed through verbatim — never interpreted, reformatted, or
    // used for authorisation. Absent title (no renderer submission yet) is an empty string,
    // matching PaneDescriptorV1.title's non-nullable `string` type elsewhere in the contract.
    title: rendererTitle ?? '',
    workspaceId,
    treeId,
    // Surfaces have no archive concept — a terminal/browser/launcher/files/review pane is either
    // currently registered or not tracked at all; there is no persisted archived state to read.
    archived: false,
    truncatedFields: [],
    observation: {
      observedAt,
      // A surface registration is only ever known from the in-process presence registry — there
      // is no persisted copy to fall back to, so this is 'live' whenever we have a descriptor to
      // return at all (an unregistered/expired surface is a NOT_FOUND at the service layer, not
      // a descriptor with a lesser freshness).
      freshness: 'live',
      cursor: `surface:${registrationId}`,
    },
    // None of the three capabilities apply: execution is unsupported/unknown (never read via a
    // capability flag), and conversation/readOutput/waitForTerminal are all unsupported below —
    // so no capability may be advertised as true without contradicting its own section.
    capabilities: {
      readOutput: false,
      subscribe: false,
      waitForTerminal: false,
    },
    activity: activityFor(kind),
    execution: executionSection(kind),
    timeline: {
      // The registration is a view, not the resource — per §6.2/§4.2 do not substitute the
      // registration time for a resource creation time. These kinds have no persistent resource,
      // so both timeline fields are null unconditionally.
      resourceCreatedAt: null,
      firstExecutionStartedAt: null,
    },
    presence,
    conversation: { status: 'unsupported', reason: CONVERSATION_UNSUPPORTED_REASON[kind] },
    lineage: { status: 'unsupported', reason: LINEAGE_UNSUPPORTED_REASON[kind] },
    runtime: { status: 'unsupported', reason: RUNTIME_UNSUPPORTED_REASON[kind] },
    latestOutput: { status: 'unsupported', reason: LATEST_OUTPUT_UNSUPPORTED_REASON[kind] },
  };
}
