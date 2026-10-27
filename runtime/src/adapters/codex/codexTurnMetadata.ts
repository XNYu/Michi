import type { FollowUpsExperimentMode, MetadataOutputMode } from '../../contract/host';

/** Overview tools are standard for Codex; only structured follow-ups need the
 * opt-in Stop-hook experiment. Keep this separate from Claude's legacy modes. */
export function codexMetadataOutputMode(
  hookEnabled: boolean,
  mode: FollowUpsExperimentMode,
): MetadataOutputMode {
  return hookEnabled && mode === 'hook-tool'
    ? 'structured-tool'
    : 'sentinel-followups-tool-overview';
}

// The turn-metadata instruction text itself is the host's
// (CodexAdapterOptions.hostText.turnMetadataInstruction; Michi: hostText/codex.ts).
