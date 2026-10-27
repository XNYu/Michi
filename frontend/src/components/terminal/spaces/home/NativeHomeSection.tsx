import React from 'react';
import type { HomeSectionKey } from 'michi-shared';
import { HomeSectionBlock } from './HomeSections';
import { useSpacesHomeSections } from './homeCounts';
import { useHomeNavigation } from './useHomeNavigation';
import { useMinuteClock } from '../../content/home/useMinuteClock';
import { requestWorkspaceHome } from '../../../../state/pages/workspaceHomeNav';

/** Live content inside the ordinary persisted page block frame. */
export function NativeHomeSection({ section, connectionId, pageId, readOnly }: {
  section: HomeSectionKey; connectionId: string; pageId: string; readOnly: boolean;
}) {
  const resource = useSpacesHomeSections(connectionId);
  const clock = useMinuteClock(true);
  const nav = useHomeNavigation(connectionId, pageId);
  return <HomeSectionBlock section={section} data={resource.data?.[section] ?? null} clock={clock}
    connectionId={readOnly ? undefined : connectionId} onAct={nav.openSectionItem}
    onOpenWorkspace={workspaceId => requestWorkspaceHome({ workspaceId, backendConnectionId: connectionId })} />;
}
