import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import { NativeResumeUnavailableError } from '../../contract/errors';
import { getClaudeJsonlPath, type ClaudeProfileOptions } from './claudeProjectsPath';
import { loadClaudeSdk } from './claudeSdkTransport';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The SDK's filesystem history helpers use the parent's global config path.
 * A narrowly scoped store keeps custom Claude profiles and cloud owners in
 * their selected directory without mutating process.env across requests.
 * The SDK still owns slicing, compaction handling and UUID/parent remapping. */
export async function forkClaudeHistory(options: ClaudeProfileOptions, input: {
  cwd: string;
  sourceNativeSessionId: string;
  nativeMessageId: string;
  ownerUserId?: string | null;
}): Promise<string> {
  if (!UUID.test(input.sourceNativeSessionId) || !UUID.test(input.nativeMessageId)) {
    throw new NativeResumeUnavailableError('Claude historical fork has no valid native position');
  }
  let raw: string;
  const sourceFile = getClaudeJsonlPath(options, input.cwd, input.sourceNativeSessionId, input.ownerUserId);
  try {
    raw = await fs.readFile(sourceFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new NativeResumeUnavailableError('Claude parent session file is unavailable');
    }
    throw error;
  }
  const entries: SessionStoreEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (entry && typeof entry === 'object' && typeof (entry as SessionStoreEntry).type === 'string') {
        entries.push(entry as SessionStoreEntry);
      }
    } catch {
      // CLI history readers also skip a truncated/unparseable journal line.
    }
  }
  let anchorIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.uuid === input.nativeMessageId && (entry.type === 'assistant' || entry.type === 'user')
      && !entry.isSidechain && entry.parent_tool_use_id == null && entry.parent_agent_id == null) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) {
    throw new NativeResumeUnavailableError('The selected Claude native history position is unavailable');
  }
  // SDK upToMessageId slices the transcript, but collects auxiliary state
  // (content replacements, relocation, titles and latches) from its entire
  // input first. Cut the journal itself so later metadata cannot rewrite or
  // relocate the selected historical state. Keep the SDK's own chain and
  // compaction resolution over this prefix, including inactive branches.
  const prefix = entries.slice(0, anchorIndex + 1);
  const output = new Map<string, SessionStoreEntry[]>();
  const store: SessionStore = {
    async load(key) {
      return key.subpath === undefined && key.sessionId === input.sourceNativeSessionId ? prefix : null;
    },
    async append(key, batch) {
      if (key.subpath !== undefined || !UUID.test(key.sessionId) || key.sessionId === input.sourceNativeSessionId) {
        throw new Error('Claude fork returned an invalid child history binding');
      }
      output.set(key.sessionId, [...(output.get(key.sessionId) ?? []), ...batch]);
    },
  };
  const sdk = await loadClaudeSdk();
  let fork: Awaited<ReturnType<typeof sdk.forkSession>>;
  try {
    fork = await sdk.forkSession(input.sourceNativeSessionId, {
      dir: input.cwd, upToMessageId: input.nativeMessageId, sessionStore: store,
    });
  } catch (error) {
    if (error instanceof Error && /^Message .+ not found in session /.test(error.message)) {
      throw new NativeResumeUnavailableError('The selected Claude native history position is unavailable');
    }
    throw error;
  }
  const child = output.get(fork.sessionId);
  if (!UUID.test(fork.sessionId) || fork.sessionId === input.sourceNativeSessionId || !child?.length || output.size !== 1) {
    throw new Error('Claude SDK did not produce an independent child history');
  }
  // Write only after SDK fork succeeds. Never overwrite a native session or
  // leave a file behind when an anchor cannot be resolved.
  const target = path.join(path.dirname(sourceFile), `${fork.sessionId}.jsonl`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, child.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      { flag: 'wx', mode: 0o600 });
    // link publishes the complete file atomically and refuses an existing ID.
    await fs.link(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return fork.sessionId;
}
