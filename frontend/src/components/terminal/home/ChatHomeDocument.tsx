import React from 'react';
import type { PageDto } from 'michi-shared';
import { useBackendScope } from '../../../hooks/useBackendScope';
import { useHomeDocument } from '../spaces/home/HomeDocument';

/** The same live document, editors and history as Pages, embedded below Chat's composer. */
export default function ChatHomeDocument({ page }: { page: PageDto }) {
  const { connectionId } = useBackendScope();
  const doc = useHomeDocument({ backendConnectionId: connectionId, initial: page });
  return <section className="michi-doc space-doc chat-home-document" aria-label="Home content">
    {doc.pageState.error && <p role="status">{doc.pageState.error}</p>}
    {doc.renderBlocks(doc.page?.blocks ?? [], 'rest')}
  </section>;
}
