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
