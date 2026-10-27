import type { ChatNodeState, Project } from './chatTypes';
import { LOCAL_BACKEND_CONNECTION_ID } from '../config/backendConnections';
import { findTreeIdForNode } from './tree';

/** Identity of the complete decoded text that was actually read, not disk bytes. */
export interface FileReadSnapshot {
  hashKind: 'sha256-text-utf8';
  contentHash: string;
  backendConnectionId: string;
  projectId: string;
  treeId?: string | null;
  resolvedFilePath: string;
  size?: number;
  modifiedAt?: number;
}

/** A destination captured independently of the current focused pane. */
export interface FileFeedbackTarget {
  backendConnectionId: string;
  projectId: string;
  treeId: string;
  nodeId: string;
}

export interface FileFeedbackContext {
  snapshot: FileReadSnapshot;
  target: FileFeedbackTarget;
}

export async function createFileReadSnapshot(
  content: string,
  provenance: Omit<FileReadSnapshot, 'hashKind' | 'contentHash'>,
): Promise<FileReadSnapshot> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { ...provenance, hashKind: 'sha256-text-utf8', contentHash };
}

/** Revalidate just before mutation; streaming targets may still accept queued feedback. */
export function isFileFeedbackTargetValid(
  target: FileFeedbackTarget,
  projects: readonly Project[],
  nodes: Readonly<Record<string, ChatNodeState>>,
): boolean {
  const project = projects.find(candidate => candidate.id === target.projectId);
  const node = nodes[target.nodeId];
  if (!project || project.deletedAt || project.archivedAt || !node || node.deletedAt || node.kind !== 'chat') return false;
  if (node.projectId !== project.id || !project.chatIds.includes(node.nodeId)) return false;
  if ((project.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID) !== target.backendConnectionId) return false;
  if (!target.treeId || findTreeIdForNode(node.nodeId, project) !== target.treeId) return false;
  const tree = project.trees.find(candidate => candidate.id === target.treeId);
  return !!tree && !tree.archivedAt && !!nodes[tree.rootNodeId] && !nodes[tree.rootNodeId].deletedAt;
}

/** A hash identifies the loaded text; it cannot recover a previous full document. */
export function formatFileSnapshotContext(snapshot: FileReadSnapshot): string {
  return `Read version: ${snapshot.hashKind} ${snapshot.contentHash} at \`${snapshot.resolvedFilePath}\`. The selected text and any line numbers belong to this already-read version. The current file may differ. This hash does not provide the old full file; verify the current file if more context is needed.`;
}
