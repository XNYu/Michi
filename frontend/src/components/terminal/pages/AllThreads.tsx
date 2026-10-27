import React from 'react';
import type { PageId } from '../../../state/commands';
import { useClearAllThreadsFilterOnLeave, useSpacesThreadsView } from '../../../state/content/allThreadsFilter';
import { MichiThreads } from './MichiThreads';

export default function AllThreads(_: { onNav?: (page: PageId) => void }) {
  const view = useSpacesThreadsView();
  useClearAllThreadsFilterOnLeave();
  return <MichiThreads state={view?.state ?? null} />;
}
