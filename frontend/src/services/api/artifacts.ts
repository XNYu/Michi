import { API_BASE_URL } from '../../config/env';

// ----- Artifact file reader -----

export interface ArtifactReadResult {
  content: string;
  path: string;
  basename: string;
  extension: string;
  size: number;
  modifiedAt: number;
}

export async function fetchArtifactContent(
  workspaceId: string,
  filePath: string,
): Promise<ArtifactReadResult> {
  const url = `${API_BASE_URL}/artifacts/${encodeURIComponent(workspaceId)}/read?path=${encodeURIComponent(filePath)}`;
  const res = await fetch(url);
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
  return `${API_BASE_URL}/workspaces/${encodeURIComponent(workspaceId)}/watch/stream`;
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
  const url = `${API_BASE_URL}/workspaces/${encodeURIComponent(workspaceId)}/watch`;
  const res = await fetch(url, {
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
