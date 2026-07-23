import { API_BASE_URL } from '../../config/env';

export interface VersionInfo {
  localHash: string;
  localDate: string;
  remoteHash: string | null;
  remoteName: string | null;
  updateAvailable: boolean;
}

export interface UpdateResult {
  ok: boolean;
  newHash?: string;
  error?: string;
  requiresConfirm?: boolean;
  reason?: 'dirty' | 'ahead';
  aheadCount?: number;
  remoteName?: string;
  branch?: string;
  backupRef?: string;
}

export async function checkVersion(): Promise<VersionInfo> {
  const res = await fetch(`${API_BASE_URL}/version`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

export async function triggerUpdate(force = false): Promise<UpdateResult> {
  const res = await fetch(`${API_BASE_URL}/version/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  return res.json();
}
