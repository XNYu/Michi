import React from 'react';
import { workspaceAccent, initialOf } from './workspaceAccent';
import type { Project } from '../../state/chatTypes';

export type WorkspaceIconMode = 'badge' | 'outline' | 'mono' | 'folder' | 'none';

interface Props {
  project: Project;
  mode: WorkspaceIconMode;
}

const SIZE = 16;

export default function WorkspaceIcon({ project, mode }: Props) {
  if (mode === 'none') return null;

  const accent = workspaceAccent(project.id);
  const letter = initialOf(project.name);

  if (mode === 'folder') {
    return (
      <span
        aria-hidden
        style={{
          width: SIZE, height: SIZE,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          color: accent, flexShrink: 0,
        }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
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
 *  Mist swaps to outline; every other palette keeps the historical solid badge. */
export function modeForPalette(palette: string): WorkspaceIconMode {
  return palette === 'mist' ? 'outline' : 'badge';
}
