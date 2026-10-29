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
