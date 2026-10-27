import type { AgentRuntime, RuntimeId } from '../contract/types';
import type { RuntimeHost } from '../contract/host';
import { createSessionDirectory, type SessionDirectory } from './sessionDirectory';
import { borrowedSessionMethods, sessionDirectoryBehind } from './sessionPortDirectory';

/**
 * Where the manager's session directory comes from. Adapters register their
 * sessions through host.sessions, so the manager must read the directory
 * behind that port.
 *
 * - `{ host }` with createDefaultHost's sessions port (no `sessions`
 *   override), or a copy of all five of its methods (`{ ...host.sessions }`):
 *   the directory behind that port. That directory reads the principal,
 *   onSessionStateChanged and observability of the host createDefaultHost
 *   returned, so a host differing in any of them throws a TypeError: a copy
 *   of that host replacing one (`{ ...host, principal }`), or another host
 *   given that port. Pass them to createDefaultHost({ ports }) instead.
 * - `{ host }` with the host's own sessions port (all five methods replaced):
 *   a new directory built from the host, createSessionDirectory({ host }),
 *   with enforceUserOwnership read from host.principal.enforceUserOwnership on
 *   every lookup, so the host persists session state and receives the
 *   directory's logs. The manager sees a session only if the host's port
 *   registers it there, for example by delegating to `manager.sessions`.
 *   A port that keeps some of createDefaultHost's methods, but not all five
 *   of one port, throws a TypeError: the kept ones still use that port's
 *   directory. Methods are recognized by function identity, so a wrapped
 *   default method (bind, forwarding) counts as the host's own: wrapping
 *   some of them throws, wrapping all five makes the port the host's own.
 *   To wrap them, replace all five and delegate to `manager.sessions`.
 * - `{ sessions }`: that directory, used as is. With a host as well, the
 *   checks above apply, and createDefaultHost's sessions port must be backed
 *   by `sessions`, else this throws a TypeError; a host's own port cannot be
 *   checked.
 */
export type RuntimeManagerOptions =
  | { sessions: SessionDirectory; host?: RuntimeHost }
  | { sessions?: undefined; host: RuntimeHost };

/** Instance-scoped runtime registry plus the session directory its runtimes share. */
export interface RuntimeManager {
  /** Registers a runtime under its id. A later runtime with the same id replaces it and keeps its list position. */
  register(runtime: AgentRuntime): void;
  get(id: RuntimeId): AgentRuntime | undefined;
  /** Runtimes in first-registration order. */
  list(): AgentRuntime[];
  readonly sessions: SessionDirectory;
}

/** The ports a session directory built by createDefaultHost reads from its host. */
const DIRECTORY_READS = ['principal', 'onSessionStateChanged', 'observability'] as const;

export function createRuntimeManager(options: RuntimeManagerOptions): RuntimeManager {
  const { host } = options;
  const behindHost = sessionDirectoryBehind(host?.sessions);
  if (host && behindHost && host !== behindHost.host) {
    const replaced = DIRECTORY_READS.filter((name) => host[name] !== behindHost.host[name]);
    if (replaced.length > 0) {
      const ports = replaced.join(', ');
      throw new TypeError(
        `createRuntimeManager: host.sessions is a createDefaultHost sessions port whose directory reads another `
        + `host's ${ports} (a copy of that host, or another host given its port), so ownership checks, session state `
        + `and logs would ignore this host. Pass ${ports} to the createDefaultHost({ ports }) that built the port, `
        + `or do not share the port.`,
      );
    }
  }
  const borrowed = behindHost ? [] : borrowedSessionMethods(host?.sessions);
  if (borrowed.length > 0) {
    throw new TypeError(
      `createRuntimeManager: host.sessions keeps ${borrowed.join(', ')} from createDefaultHost's sessions ports, `
      + 'but not all five methods of one port; the kept ones still use their port\'s directory, so registrations and '
      + 'lookups may split (the package cannot see through a method that was replaced or wrapped). Replace all five '
      + 'methods (for example by delegating them to manager.sessions), or none.',
    );
  }
  let sessions = options.sessions;
  if (sessions) {
    if (behindHost && behindHost.directory !== sessions) {
      throw new TypeError(
        'createRuntimeManager: sessions is not the directory that host.sessions registers into, so this manager '
        + 'would not see the sessions adapters register. Pass only { host }, or give createDefaultHost a '
        + 'ports.sessions that registers into sessions.',
      );
    }
  } else if (behindHost) {
    sessions = behindHost.directory;
  } else {
    if (!host) throw new TypeError('createRuntimeManager: pass sessions or host');
    sessions = createSessionDirectory({ host, enforceUserOwnership: () => host.principal.enforceUserOwnership() });
  }
  const runtimes = new Map<RuntimeId, AgentRuntime>();
  return {
    sessions,
    register(runtime) {
      runtimes.set(runtime.id, runtime);
    },
    get(id) {
      return runtimes.get(id);
    },
    list() {
      return Array.from(runtimes.values());
    },
  };
}
