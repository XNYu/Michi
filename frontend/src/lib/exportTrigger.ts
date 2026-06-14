import { createContext, useContext } from 'react';
import type { Project, ChatNodeState } from '../state/chatStore';

export interface ExportTrigger {
  /** Request a workspace or subtree export. Opens the progress modal. */
  request(
    project: Project,
    rootNodeId: string,
    nodes: Record<string, ChatNodeState>,
    nodeIds?: string[],
  ): void;
}

export const ExportTriggerContext = createContext<ExportTrigger | null>(null);

export function useExportTrigger(): ExportTrigger {
  const v = useContext(ExportTriggerContext);
  if (!v) throw new Error('useExportTrigger must be used within an ExportTriggerContext provider');
  return v;
}
