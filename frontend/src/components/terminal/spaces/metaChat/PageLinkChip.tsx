import React, { useState } from 'react';
import { FileText } from 'lucide-react';
import { openSpacesPage } from '../../../../state/metaChat/spacesPages';
import { useMetaChatRevealPage } from './MetaChatArea';

function textOf(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(children)) return textOf(children.props.children);
  return '';
}

/** A `michi://page/<id>[?block=<id>]` link in an assistant reply: opens the page and flashes the block. */
export function PageLinkChip({ id, blockId, children }: { id: string; blockId?: string; children: React.ReactNode }) {
  const label = textOf(children).trim() || 'Page';
  const [gone, setGone] = useState(false);
  const revealPage = useMetaChatRevealPage();
  return (
    <button
      type="button"
      className="assistant-cite"
      data-assistant-link={blockId ? 'page-block' : 'page'}
      aria-disabled={gone || undefined}
      title={gone ? `${label} — deleted` : label}
      onClick={() => {
        if (!gone) revealPage?.();
        void openSpacesPage({ pageId: id, ...(blockId ? { blockId } : {}) }).then((result) => { if (result === 'deleted') setGone(true); });
      }}
    >
      <span className="assistant-cite__icon" aria-hidden="true"><FileText size={11} /></span>
      <span className="assistant-cite__text">{label}</span>
      {gone && <span className="assistant-cite__note">deleted</span>}
    </button>
  );
}
