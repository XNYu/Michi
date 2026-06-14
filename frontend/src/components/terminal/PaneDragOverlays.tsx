import React from 'react';

export function PaneDropIndicator({ side }: { side: 'left' | 'right' | null }) {
  if (!side) return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        [side]: -1,
        width: 3,
        background: 'var(--term-accent)',
        pointerEvents: 'none',
        zIndex: 60,
      } as React.CSSProperties}
    />
  );
}

export function FileDropOverlay({
  visible,
  fileCount,
}: {
  visible: boolean;
  fileCount: number;
}) {
  if (!visible) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        border: '2px dashed var(--term-accent)',
        background: 'rgba(47, 143, 115, .15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: 'var(--term-bg)',
          border: '1px solid var(--term-accent)',
          color: 'var(--term-accent)',
          padding: '8px 18px',
          fontFamily: 'var(--ui-font)',
          fontSize: 12,
          borderRadius: 3,
          boxShadow: '0 4px 14px rgba(0,0,0,.08)',
        }}
      >
        drop {fileCount} file{fileCount === 1 ? '' : 's'} · attach to message
      </div>
    </div>
  );
}
