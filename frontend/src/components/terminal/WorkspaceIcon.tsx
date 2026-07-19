import React from 'react';
import { workspaceAccent, initialOf } from './workspaceAccent';
import type { Project } from '../../state/chatTypes';

export type WorkspaceIconMode = 'badge' | 'outline' | 'mono' | 'folder' | 'none';

interface Props {
  project: Project;
  mode: WorkspaceIconMode;
  /** Folder mode tints every workspace with its own accent; `active` makes that
   *  workspace the anchor (full opacity + heavier stroke + faint fill) while the
   *  rest sit back at reduced opacity. Only consulted by `folder` mode. */
  active?: boolean;
}

const SIZE = 16;

export default function WorkspaceIcon({ project, mode, active = false }: Props) {
  if (mode === 'none') return null;

  const accent = workspaceAccent(project.id);
  const letter = initialOf(project.name);

  if (mode === 'folder') {
    // Every workspace gets its own accent-colored outline (hollow, so it stays
    // far quieter than the old filled letter-badges that read as rainbow noise).
    // The active workspace is the anchor: full opacity + slightly heavier stroke
    // + a faint accent fill. Inactive folders keep their hue but sit back at
    // reduced opacity, so identity and the active anchor both come through.
    return (
      <span
        aria-hidden
        style={{
          // Slot width == glyph width (15) so the folder has no internal
          // horizontal padding — its left edge is the slot left edge. The
          // WorkspaceRow then positions this slot so the glyph sits centered
          // between the sidebar edge and the workspace text, with the text
          // left-aligned to the thread rows below it. Keep math in sync there.
          width: 15, height: SIZE,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          color: accent, opacity: active ? 1 : 0.7, flexShrink: 0,
        }}
      >
        <svg width={15} height={15} viewBox="0 0 24 24"
             fill={active ? `${accent}22` : 'none'} stroke="currentColor"
             strokeWidth={active ? 1.9 : 1.7} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      </span>
    );
  }

  const base: React.CSSProperties = {
    width: SIZE, height: SIZE,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10.5, fontWeight: 700, flexShrink: 0, boxSizing: 'border-box',
  };

  if (mode === 'outline') {
    return (
      <span style={{ ...base, color: accent, border: `1.5px solid ${accent}` }}>{letter}</span>
    );
  }
  if (mode === 'mono') {
    return (
      <span style={{ ...base, background: 'var(--term-faint)', color: '#fff' }}>{letter}</span>
    );
  }
  // mode === 'badge' (default)
  return (
    <span style={{ ...base, background: accent, color: '#fff' }}>{letter}</span>
  );
}

/** Resolve which workspace-icon mode to use for a given palette.
 *  All palettes now use the muted folder glyph (one accent anchor on the active
 *  workspace) instead of the old per-workspace colored letter badge, which read
 *  as rainbow noise with no system behind it. `palette` is kept for signature
 *  stability and future per-theme overrides. */
export function modeForPalette(_palette: string): WorkspaceIconMode {
  return 'folder';
}
