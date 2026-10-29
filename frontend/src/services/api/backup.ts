import { API_BASE_URL } from '../../config/env';
import { responseError } from './httpError';

// Portable archives must retain their original IDs, without remote entity mapping.
export interface PortableBackup {
  app: 'michi';
  version: 1 | 2;
  exportedAt?: number;
  workspaces: Array<{ workspace: { id: string; name?: string }; [key: string]: unknown }>;
  agents?: unknown;
}

export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export function parseBackup(text: string): PortableBackup {
  let value: any;
  try { value = JSON.parse(text); } catch { throw new Error('Choose a valid JSON backup file.'); }
  if (!value || value.app !== 'michi' || ![1, 2].includes(value.version)
    || !Array.isArray(value.workspaces)
    || (value.version === 2 && (!value.agents || typeof value.agents !== 'object'))
    || value.workspaces.some((entry: any) => !entry?.workspace || typeof entry.workspace.id !== 'string'
      || ['trees', 'nodes', 'edges', 'messages', 'contexts'].some(key => !Array.isArray(entry[key])))) {
    throw new Error('This file is not a supported Michi backup.');
  }
  return value;
}

export async function exportBackup(): Promise<PortableBackup> {
  const response = await fetch(`${API_BASE_URL}/backup/export`);
  if (!response.ok) throw await responseError(response, 'Backup');
  return parseBackup(await response.text());
}

export async function restoreBackup(backup: PortableBackup): Promise<{ workspaceCount: number }> {
  const response = await fetch(`${API_BASE_URL}/backup/import?mode=merge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backup),
  });
  if (!response.ok) throw await responseError(response, 'Restore');
  return response.json();
}

export function downloadBackup(backup: PortableBackup): void {
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `michi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
