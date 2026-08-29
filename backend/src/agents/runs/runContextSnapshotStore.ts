import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { AgentRunContextEntryV1, AgentRunContextManifestV1 } from 'michi-shared';
import type { RunContextSnapshotStore } from './ports';
import { normalizeContextManifest } from './contextManifest';

export interface FileRunContextSnapshotStoreOptions {
  dataDir: string;
  /** Roots from which artifact/file snapshotPath values may be copied. */
  allowedSourceRoots?: readonly string[];
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`${label} is not path-safe`);
  }
  return value;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function cloneManifest(manifest: AgentRunContextManifestV1): AgentRunContextManifestV1 {
  return JSON.parse(JSON.stringify(normalizeContextManifest(manifest))) as AgentRunContextManifestV1;
}

function manifestIdentity(manifest: AgentRunContextManifestV1): string {
  return JSON.stringify({ ...manifest, entries: manifest.entries.map((entry) =>
    entry.kind === 'artifact' || entry.kind === 'file' ? { ...entry, snapshotPath: null } : entry) });
}

export class FileRunContextSnapshotStore implements RunContextSnapshotStore {
  private readonly root: string;
  private readonly allowedSourceRoots: string[];

  constructor(options: FileRunContextSnapshotStoreOptions) {
    if (!path.isAbsolute(options.dataDir)) throw new Error('Run context dataDir must be absolute');
    this.root = path.join(options.dataDir, 'agent-runs', 'context-snapshots');
    this.allowedSourceRoots = (options.allowedSourceRoots ?? [options.dataDir]).map((root) => path.resolve(root));
  }

  async snapshot(input: {
    ownerUserId: string;
    workspaceId: string;
    runOperationId: string;
    manifest: AgentRunContextManifestV1;
  }): Promise<AgentRunContextManifestV1> {
    const owner = safeId(input.ownerUserId, 'ownerUserId');
    const workspace = safeId(input.workspaceId, 'workspaceId');
    const operation = safeId(input.runOperationId, 'runOperationId');
    await mkdir(this.root, { recursive: true });
    const destination = path.join(this.root, operation);
    const manifestPath = path.join(destination, 'manifest.json');
    const ownershipPath = path.join(destination, 'ownership.json');
    const requested = cloneManifest(input.manifest);
    try {
      const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as AgentRunContextManifestV1;
      const ownership = JSON.parse(await readFile(ownershipPath, 'utf8')) as { ownerUserId: string; workspaceId: string };
      if (ownership.ownerUserId !== owner || ownership.workspaceId !== workspace) {
        throw new Error('Run context snapshot belongs to another owner or workspace');
      }
      if (manifestIdentity(existing) === manifestIdentity(requested)) return existing;
      throw new Error('Run context snapshot already exists with different contents');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporary = path.join(this.root, `.${operation}.tmp-${process.pid}-${Date.now()}`);
    await rm(temporary, { recursive: true, force: true });
    await mkdir(path.join(temporary, 'files'), { recursive: true });
    try {
      const entries: AgentRunContextEntryV1[] = [];
      for (let index = 0; index < requested.entries.length; index += 1) {
        const entry = requested.entries[index];
        if (entry.kind !== 'artifact' && entry.kind !== 'file') {
          entries.push({ ...entry });
          continue;
        }
        const sourceLink = await lstat(entry.snapshotPath);
        if (sourceLink.isSymbolicLink() || !sourceLink.isFile()) throw new Error(`context entry ${index} must reference a regular non-symlink file`);
        const source = await realpath(entry.snapshotPath);
        const roots = await Promise.all(this.allowedSourceRoots.map(async (root) => {
          try { return await realpath(root); } catch { return path.resolve(root); }
        }));
        if (!roots.some((root) => inside(root, source))) throw new Error(`context entry ${index} escapes allowed snapshot roots`);
        const sourceStat = await stat(source);
        if (sourceStat.size !== entry.size) throw new Error(`context entry ${index} size does not match its manifest`);
        const digest = await sha256(source);
        if (digest.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error(`context entry ${index} SHA-256 does not match its manifest`);
        const fileName = `${index}-${digest}`;
        const target = path.join(temporary, 'files', fileName);
        await copyFile(source, target);
        const copiedDigest = await sha256(target);
        if (copiedDigest !== digest) throw new Error(`context entry ${index} changed while being snapshotted`);
        entries.push({ ...entry, snapshotPath: path.join(destination, 'files', fileName), sha256: digest });
      }
      const output = { ...requested, entries };
      await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify(output, null, 2), { encoding: 'utf8', flag: 'wx' });
      await writeFile(path.join(temporary, 'ownership.json'), JSON.stringify({ ownerUserId: owner, workspaceId: workspace }), { encoding: 'utf8', flag: 'wx' });
      try {
        await rename(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
        const existing = JSON.parse(await readFile(manifestPath, 'utf8')) as AgentRunContextManifestV1;
        const ownership = JSON.parse(await readFile(ownershipPath, 'utf8')) as { ownerUserId: string; workspaceId: string };
        if (ownership.ownerUserId !== owner || ownership.workspaceId !== workspace
          || manifestIdentity(existing) !== manifestIdentity(output)) {
          throw new Error('Run context snapshot race produced different contents');
        }
      }
      return output;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async cleanup(runId: string): Promise<void> {
    const operation = safeId(runId, 'runId');
    await rm(path.join(this.root, operation), { recursive: true, force: true });
  }
}
