import React from 'react';
import { ChevronLeft, Layers, X } from 'lucide-react';
import { Button } from '../../ui/controls';
import {
  closeSourcePopover, dismissSourceBack, openPopoverSource, returnToSourceOrigin, useSourceNav,
} from '../../../state/sourceNav/sourceNav';
import { SourcePopover } from './SourcePopover';
import './source.css';

/** The shell's one source popover, opened by any "Source" link through openSourcePopover. */
export function SourcePopoverHost() {
  const { popover } = useSourceNav();
  if (!popover) return null;
  const key = `${popover.target.backendConnectionId}:${popover.target.nodeId}:${popover.target.messageId ?? ''}`;
  return (
    <SourcePopover
      key={key}
      popover={popover}
      onClose={closeSourcePopover}
      onGo={(focus, preview) => {
        void openPopoverSource(focus, preview ? { nodeId: preview.nodeId, workspaceId: preview.workspaceId, messageId: preview.message?.id ?? null } : null);
      }}
    />
  );
}

/** "From Spaces' <page> · Back to <page>": stays above the conversations until it is used or closed. */
export function SourceBackBar({ contentWidth }: { contentWidth?: number | null }) {
  const { back } = useSourceNav();
  if (!back) return null;
  const title = back.origin.title || 'page';
  return (
    <div className="source-back">
      <div className="source-back__bar" role="navigation" aria-label="Back to Pages" style={contentWidth ? { maxWidth: contentWidth } : undefined}>
        <Layers size={13} strokeWidth={1.7} aria-hidden="true" className="source-back__icon" />
        <span className="source-back__from">From Pages’ “{title}”</span>
        <span className="source-back__spacer" />
        <Button size="sm" onClick={returnToSourceOrigin}>
          <ChevronLeft size={12} strokeWidth={1.8} aria-hidden="true" />Back to “{title}”
        </Button>
        <button type="button" className="t-icon-btn source-back__close" aria-label="Close the back bar" onClick={dismissSourceBack}>
          <X size={12} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
