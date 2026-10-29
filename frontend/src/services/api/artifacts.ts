import { serverEntityId } from '../../config/backendIdentity';
import { backendFetch } from './backendRequest';
import { workspaceBackendApiBase } from '../../config/backendConnections';

// ----- Artifact file reader -----

export interface ArtifactReadResult {
  content: string;
  imageMime?: string;
  path: string;
  basename: string;
  extension: string;
  size: number;
  modifiedAt: number;
}

export async function fetchArtifactContent(
  workspaceId: string,
  filePath: string,
  preview = false,
): Promise<ArtifactReadResult> {
  const url = `${workspaceBackendApiBase(workspaceId)}/artifacts/${encodeURIComponent(serverEntityId(workspaceId))}/read?path=${encodeURIComponent(filePath)}${preview ? '&preview=1' : ''}`;
  const res = await backendFetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(body.error || `Failed to load artifact: ${res.status}`);
  }
  return res.json() as Promise<ArtifactReadResult>;
}

// ----- Artifact live-refresh watch channel -----
//
// A persistent SSE channel notifies an open ArtifactPane that a watched file
// changed on disk (from any source). `useArtifactWatch` opens the stream and
// declares which paths to watch; the backend maps changes back to the stored
// path so the frontend can string-match against open panes.

/** Persistent SSE endpoint for a workspace's artifact-change notifications. */
export function artifactWatchStreamUrl(workspaceId: string): string {
  return `${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId))}/watch/stream`;
}

/**
 * Declare/replace the set of stored paths to watch for a workspace. Returns the
 * subset the backend accepted (paths escaping the cwd sandbox are dropped).
 * Idempotent — safe to re-declare on every stream `open` and registry change.
 */
export async function postArtifactWatchPaths(
  workspaceId: string,
  paths: string[],
): Promise<string[]> {
  const url = `${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(serverEntityId(workspaceId))}/watch`;
  const res = await backendFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) {
    throw new Error(`Failed to declare artifact watch paths: ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as { watching?: string[] };
  return body.watching ?? [];
}

/** Authenticated download also works for remote gateways requiring headers. */
export async function downloadArtifactFile(workspaceId: string, filePath: string): Promise<void> {
  const url = `${workspaceBackendApiBase(workspaceId)}/artifacts/${encodeURIComponent(serverEntityId(workspaceId))}/download?path=${encodeURIComponent(filePath)}`;
  const response = await backendFetch(url);
  if (!response.ok) throw new Error(`Could not download file (${response.status})`);
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filePath.split('/').pop() || 'artifact';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

export function artifactImageUrl(workspaceId: string, filePath: string): string {
  return `${workspaceBackendApiBase(workspaceId)}/files/${encodeURIComponent(serverEntityId(workspaceId))}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}
