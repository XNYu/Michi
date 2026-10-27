import React from 'react';
import './michi.css';

export type MichiTagVariant = 'new' | 'agent-says' | 'you-edited' | 'back-after-archive' | 'ignored' | 'archived';

const DEFAULT_TEXT: Record<MichiTagVariant, string> = {
  new: 'NEW',
  'agent-says': 'Agent says',
  'you-edited': 'You edited',
  'back-after-archive': 'Back after archive',
  ignored: 'ignored',
  archived: 'Archived',
};

/**
 * Michi's small bordered mono tags. Each variant owns one colour (and the
 * agent's claim a dashed border): NEW in accent, Agent says in digest,
 * You edited in mauve, Back after archive in the select amber, ignored and
 * Archived muted.
 */
export function MichiTag({
  variant,
  children,
  id,
  title,
}: {
  variant: MichiTagVariant;
  children?: React.ReactNode;
  id?: string;
  title?: string;
}) {
  return (
    <span id={id} className="michi-tag" data-variant={variant} title={title}>
      {children ?? DEFAULT_TEXT[variant]}
    </span>
  );
}
