import { API_BASE_URL } from '../../config/env';

export type UploadPhase = 'preparing' | 'uploading';

export interface UploadProgress {
  phase: UploadPhase;
  loaded: number;
  total: number | null;
  percent: number | null;
}

export interface UploadProgressOptions {
  onProgress?: (progress: UploadProgress) => void;
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function combineUploadProgress(
  onProgress: ((progress: UploadProgress) => void) | undefined,
  phase: UploadPhase,
  startPercent: number,
  endPercent: number,
): ((progress: UploadProgress) => void) | undefined {
  if (!onProgress) return undefined;
  return (progress) => {
    const pct = progress.percent == null
      ? null
      : clampPercent(startPercent + (progress.percent / 100) * (endPercent - startPercent));
    onProgress({
      ...progress,
      phase,
      percent: pct,
    });
  };
}

function readFileAsArrayBuffer(
  file: File,
  onProgress?: (progress: UploadProgress) => void,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    onProgress?.({
      phase: 'preparing',
      loaded: 0,
      total: file.size || null,
      percent: file.size === 0 ? 100 : 0,
    });
    reader.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : file.size || null;
      onProgress?.({
        phase: 'preparing',
        loaded: event.loaded,
        total,
        percent: total ? clampPercent((event.loaded / total) * 100) : null,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => {
      onProgress?.({
        phase: 'preparing',
        loaded: file.size,
        total: file.size || null,
        percent: 100,
      });
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error('file read did not produce bytes'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsArrayBuffer(file);
  });
}

function postJsonWithUploadProgress<T>(
  path: string,
  payload: unknown,
  options?: UploadProgressOptions,
): Promise<T> {
  const body = JSON.stringify(payload);
  if (!options?.onProgress) {
    return fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
        throw new Error(err.error || `request failed: ${res.status}`);
      }
      return res.json() as Promise<T>;
    });
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}${path}`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : null;
      options.onProgress?.({
        phase: 'uploading',
        loaded: event.loaded,
        total,
        percent: total ? clampPercent((event.loaded / total) * 100) : null,
      });
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.onabort = () => reject(new Error('upload cancelled'));
    xhr.onload = () => {
      const raw = xhr.responseText || '{}';
      let json: any;
      try {
        json = JSON.parse(raw);
      } catch {
        json = { error: raw || `status ${xhr.status}` };
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(json?.error || `request failed: ${xhr.status}`));
        return;
      }
      options.onProgress?.({
        phase: 'uploading',
        loaded: body.length,
        total: body.length,
        percent: 100,
      });
      resolve(json as T);
    };
    options.onProgress?.({
      phase: 'uploading',
      loaded: 0,
      total: body.length,
      percent: 0,
    });
    xhr.send(body);
  });
}

const webCwdCache = new Map<string, string>();
export async function getWebUploadCwd(workspaceId: string): Promise<string> {
  const cached = webCwdCache.get(workspaceId);
  if (cached) return cached;
  const res = await fetch(`${API_BASE_URL}/uploads/web-cwd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `getWebUploadCwd failed: ${res.status}`);
  }
  const json = await res.json();
  if (typeof json?.cwd !== 'string') throw new Error('getWebUploadCwd: missing cwd');
  webCwdCache.set(workspaceId, json.cwd);
  return json.cwd;
}

// Cloud mode requires `workspaceId` so the backend can:
//   1. enforce per-user ownership via requireWorkspaceOwner
//   2. derive the sandbox cwd server-side and ignore the client cwd
// Desktop mode ignores workspaceId and uses the client-supplied cwd directly,
// so the parameter is required by the type but harmless when omitted in tests.
export async function importWorkspaceFile(
  workspaceId: string,
  cwd: string,
  originalName: string,
  content: string,
  options?: UploadProgressOptions & { subdir?: string },
): Promise<{ name: string; displayName?: string; filePath: string; size: number }> {
  try {
    return await postJsonWithUploadProgress(
      '/workspaces/import-file',
      { workspaceId, cwd, originalName, content, subdir: options?.subdir },
      options,
    );
  } catch (err) {
    throw new Error((err as Error).message || 'importWorkspaceFile failed');
  }
}

export async function importWorkspaceFileBinary(
  workspaceId: string,
  cwd: string,
  originalName: string,
  bytes: ArrayBuffer | Uint8Array,
  options?: UploadProgressOptions & { subdir?: string },
): Promise<{ name: string; displayName?: string; filePath: string; size: number }> {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Encode to base64 in chunks to avoid String.fromCharCode argument cap on
  // large blobs (~125k arg limit on some engines).
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  }
  const contentBase64 = btoa(binary);
  try {
    return await postJsonWithUploadProgress(
      '/workspaces/import-file',
      { workspaceId, cwd, originalName, contentBase64, subdir: options?.subdir },
      options,
    );
  } catch (err) {
    throw new Error((err as Error).message || 'importWorkspaceFileBinary failed');
  }
}

export async function importWorkspaceFileUpload(
  workspaceId: string,
  cwd: string,
  file: File,
  options?: UploadProgressOptions & { originalName?: string; subdir?: string },
): Promise<{ name: string; displayName?: string; filePath: string; size: number }> {
  const originalName = options?.originalName ?? file.name;
  if (file.size === 0) {
    return importWorkspaceFile(workspaceId, cwd, originalName, '', options);
  }
  const readProgress = combineUploadProgress(options?.onProgress, 'preparing', 0, 10);
  const uploadProgress = combineUploadProgress(options?.onProgress, 'uploading', 10, 100);
  const bytes = await readFileAsArrayBuffer(file, readProgress);
  return importWorkspaceFileBinary(workspaceId, cwd, originalName, bytes, {
    onProgress: uploadProgress,
    subdir: options?.subdir,
  });
}

/**
 * Link (not copy) an externally-picked file into <cwd>/.artifacts/ via a symlink.
 * Zero bytes copied; the linked path resolves through the symlink so the agent's
 * fs tools read/write the external original live. Desktop/Electron only — the
 * backend refuses in cloud mode (per-user sandbox must not point at host paths).
 * `sourcePath` is the absolute disk path from the Electron file picker.
 */
export async function linkWorkspaceFile(
  workspaceId: string,
  cwd: string,
  sourcePath: string,
): Promise<{ name: string; displayName?: string; filePath: string; size: number }> {
  const res = await fetch(`${API_BASE_URL}/workspaces/link-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceId, cwd, sourcePath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `status ${res.status}` }));
    throw new Error(err.error || `linkWorkspaceFile failed: ${res.status}`);
  }
  return res.json();
}
