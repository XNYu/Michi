import { createHash } from 'node:crypto';
import type { AgentRunContextEntryV1, AgentRunContextManifestV1 } from 'michi-shared';

function identity(entry: AgentRunContextEntryV1): string {
  switch (entry.kind) {
    case 'message': return `message:${entry.nodeId}:${entry.messageId}`;
    case 'artifact': return `artifact:${entry.artifactId}`;
    case 'file': return `file:${entry.workspacePath}`;
    case 'summary': return `summary:${entry.label}`;
    case 'workspace_instructions': return 'workspace_instructions';
  }
}

export function normalizeContextManifest(manifest: AgentRunContextManifestV1): AgentRunContextManifestV1 {
  const entries = manifest.entries.map((entry) => ({ ...entry }));
  const identities = entries.map(identity);
  if (new Set(identities).size !== identities.length) throw new Error('context manifest contains duplicate identities');
  return { ...manifest, entries };
}

export function contextManifestHash(manifest: AgentRunContextManifestV1): string {
  const normalized = normalizeContextManifest(manifest);
  return createHash('sha256').update(JSON.stringify(normalized.entries)).digest('hex');
}
