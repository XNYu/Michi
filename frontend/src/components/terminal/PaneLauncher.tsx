import React from 'react';
import { toast } from 'sonner';
import { useChatActions } from '../../state/chatStore';

export default function PaneLauncher() {
  const { openLauncherPane } = useChatActions();

  return (
    <button
      type="button"
      className="t-icon-btn"
      aria-label="New pane"
      title="New pane"
      onClick={() => {
        try {
          openLauncherPane();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Unable to open pane');
        }
      }}
      style={{
        width: 26,
        height: 26,
        fontSize: 16,
        color: 'var(--term-mid)',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      +
    </button>
  );
}
