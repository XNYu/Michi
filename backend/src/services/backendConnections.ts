import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getMichiDataDir } from './dataDir';

const CONFIG_PATH = () => path.join(getMichiDataDir(), 'config.json');

export type BackendConnectionTransport = 'direct' | 'ssh';

export interface BackendConnectionRecord {
  id: string;
  name: string;
  transport: BackendConnectionTransport;
  apiUrl: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: number;
  remotePort?: number;
  token: string;
  createdAt: number;
  updatedAt: number;
}

export interface BackendConnectionSummary {
  id: string;
  name: string;
  transport: BackendConnectionTransport;
  apiUrl: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: number;
  remotePort?: number;
  tunnelStatus?: 'disconnected' | 'connecting' | 'connected' | 'error';
  tunnelError?: string;
  hasToken: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BackendConnectionInput {
  id?: string;
  name: string;
  transport?: BackendConnectionTransport;
  apiUrl?: string;
  sshHost?: string;
  sshUser?: string;
  sshPort?: number | null;
  remotePort?: number | null;
  token?: string;
}

interface MichiConfigFile {
  backendConnections?: unknown;
  [key: string]: unknown;
}

function readConfig(): MichiConfigFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as MichiConfigFile
      : {};
  } catch {
    return {};
  }
}

function writeConfig(config: MichiConfigFile): void {
  const filePath = CONFIG_PATH();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function parseRecord(value: unknown): BackendConnectionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const transport: BackendConnectionTransport = row.transport === 'ssh' ? 'ssh' : 'direct';
  if (
    typeof row.id !== 'string'
    || typeof row.name !== 'string'
    || typeof row.apiUrl !== 'string'
    || typeof row.token !== 'string'
  ) return null;
  if (transport === 'ssh' && typeof row.sshHost !== 'string') return null;
  return {
    id: row.id,
    name: row.name,
    transport,
    apiUrl: row.apiUrl,
    sshHost: transport === 'ssh' ? row.sshHost as string : undefined,
    sshUser: typeof row.sshUser === 'string' ? row.sshUser : undefined,
    sshPort: typeof row.sshPort === 'number' ? row.sshPort : undefined,
    remotePort: typeof row.remotePort === 'number' ? row.remotePort : transport === 'ssh' ? 3000 : undefined,
    token: row.token,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : Date.now(),
  };
}

function readRecords(): BackendConnectionRecord[] {
  const raw = readConfig().backendConnections;
  return Array.isArray(raw) ? raw.flatMap((value) => {
    const parsed = parseRecord(value);
    return parsed ? [parsed] : [];
  }) : [];
}

function summary(record: BackendConnectionRecord): BackendConnectionSummary {
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    apiUrl: record.apiUrl,
    sshHost: record.sshHost,
    sshUser: record.sshUser,
    sshPort: record.sshPort,
    remotePort: record.remotePort,
    hasToken: record.token.length > 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function normalizeBackendApiUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Backend URL is required');
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    throw new Error('Backend URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Backend URL must use http or https');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Backend URL must not contain credentials, a query, or a fragment');
  }
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname || pathname === '/') pathname = '/api';
  else if (!pathname.endsWith('/api')) pathname = `${pathname}/api`;
  url.pathname = pathname;
  return url.toString().replace(/\/$/, '');
}

function normalizeSshHost(raw: string): string {
  const host = raw.trim();
  if (!host) throw new Error('SSH host is required');
  if (host.length > 255) throw new Error('SSH host is too long');
  if (host.startsWith('-') || /\s/.test(host) || host.includes('@')) {
    throw new Error('SSH host must be a hostname or SSH config alias');
  }
  return host;
}

function normalizeSshUser(raw: string | undefined): string | undefined {
  const user = raw?.trim();
  if (!user) return undefined;
  if (user.length > 128 || user.startsWith('-') || /[\s@]/.test(user)) {
    throw new Error('SSH user is invalid');
  }
  return user;
}

function normalizePort(value: number | null | undefined, fallback: number, label: string): number {
  const port = value == null ? fallback : value;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

export function normalizeBackendConnection(
  input: BackendConnectionInput,
  existing?: BackendConnectionRecord,
): BackendConnectionRecord {
  const name = input.name.trim();
  if (!name) throw new Error('Connection name is required');
  if (name.length > 80) throw new Error('Connection name must be 80 characters or fewer');
  const transport = input.transport ?? existing?.transport ?? 'direct';
  const now = Date.now();
  const token = input.token === undefined || (existing && input.token.trim() === '')
    ? existing?.token ?? ''
    : input.token.trim();

  if (transport === 'ssh') {
    return {
      id: existing?.id ?? input.id ?? `remote-${randomUUID()}`,
      name,
      transport,
      apiUrl: '',
      sshHost: normalizeSshHost(input.sshHost ?? existing?.sshHost ?? ''),
      sshUser: normalizeSshUser(input.sshUser === undefined ? existing?.sshUser : input.sshUser),
      sshPort: input.sshPort === null
        ? undefined
        : input.sshPort === undefined
          ? existing?.sshPort
          : normalizePort(input.sshPort, 22, 'SSH port'),
      remotePort: normalizePort(input.remotePort, existing?.remotePort ?? 3000, 'Remote port'),
      token,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  return {
    id: existing?.id ?? input.id ?? `remote-${randomUUID()}`,
    name,
    transport,
    apiUrl: normalizeBackendApiUrl(input.apiUrl ?? existing?.apiUrl ?? ''),
    token,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export function listBackendConnections(): BackendConnectionSummary[] {
  return readRecords().map(summary);
}

export function getBackendConnection(id: string): BackendConnectionRecord | null {
  return readRecords().find((record) => record.id === id) ?? null;
}

export function saveBackendConnection(input: BackendConnectionInput): BackendConnectionSummary {
  const config = readConfig();
  const records = readRecords();
  const existing = input.id ? records.find((record) => record.id === input.id) : undefined;
  if (input.id && !existing) throw new Error('Connection not found');
  const record = normalizeBackendConnection(input, existing);
  const duplicate = records.find((candidate) => (
    candidate.id !== existing?.id
    && candidate.transport === record.transport
    && (record.transport === 'direct'
      ? candidate.apiUrl === record.apiUrl
      : candidate.sshHost === record.sshHost
        && candidate.sshUser === record.sshUser
        && (candidate.sshPort ?? 22) === (record.sshPort ?? 22)
        && (candidate.remotePort ?? 3000) === (record.remotePort ?? 3000))
  ));
  if (duplicate) throw new Error('A connection for this backend already exists');
  const nextRecords = existing
    ? records.map((candidate) => candidate.id === existing.id ? record : candidate)
    : [...records, record];
  writeConfig({ ...config, backendConnections: nextRecords });
  return summary(record);
}

export function deleteBackendConnection(id: string): boolean {
  const config = readConfig();
  const records = readRecords();
  const next = records.filter((record) => record.id !== id);
  if (next.length === records.length) return false;
  writeConfig({ ...config, backendConnections: next });
  return true;
}

export async function probeBackendConnection(input: {
  apiUrl: string;
  token?: string;
  timeoutMs?: number;
}): Promise<{ ok: true; apiUrl: string; serverId?: string } | { ok: false; apiUrl?: string; error: string }> {
  let apiUrl: string;
  try {
    apiUrl = normalizeBackendApiUrl(input.apiUrl);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 8_000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = input.token?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${apiUrl}/health`, { headers, signal: controller.signal });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const detail = body && typeof body.error === 'string' ? `: ${body.error}` : '';
      return { ok: false, apiUrl, error: `Backend returned ${response.status}${detail}` };
    }
    if (body?.service !== 'michi-backend' || body?.status !== 'healthy') {
      return { ok: false, apiUrl, error: 'The server did not identify itself as a Michi backend' };
    }
    return {
      ok: true,
      apiUrl,
      serverId: typeof body.serverId === 'string' ? body.serverId : undefined,
    };
  } catch (err) {
    const message = (err as Error).name === 'AbortError'
      ? 'Connection timed out'
      : (err as Error).message || 'Connection failed';
    return { ok: false, apiUrl, error: message };
  } finally {
    clearTimeout(timer);
  }
}
