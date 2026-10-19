import { isLocalCredentialError, type RemoteServiceRecoveryStatus } from 'michi-shared';
import { getBackendConnection } from './backendConnections';
import { RemoteDiagnosticLog } from './remoteDiagnostics';
import { RemoteDesktopError, RemoteDesktopSetup } from './remoteDesktopSetup';

export function isSshAuthenticationError(message: string): boolean {
  return /Permission denied|Authentication failed|credentials? (?:have |has )?expired|certificate.*expired|unauthorized/i.test(message) || isLocalCredentialError(message);
}

/** One bounded startup per saved machine, shared by all failing requests. */
export class RemoteServiceRecovery {
  private jobs = new Map<string, { status: RemoteServiceRecoveryStatus; controller: AbortController; done: Promise<void>; updatedAt: number }>();
  constructor(private readonly setup: RemoteDesktopSetup, private readonly timeoutMs = 45_000) {}

  private current(status: RemoteServiceRecoveryStatus): RemoteServiceRecoveryStatus {
    return status.phase === 'starting' ? { ...status, message: status.diagnostic?.message ?? status.message } : status;
  }

  statuses(): RemoteServiceRecoveryStatus[] {
    return [...this.jobs.values()].map(job => this.current(job.status));
  }

  start(id: string, force = false): RemoteServiceRecoveryStatus | undefined {
    const connection = getBackendConnection(id);
    if (!connection || connection.transport !== 'ssh' || !connection.sshHost) return;
    const previous = this.jobs.get(id);
    if (previous?.status.phase === 'starting' || (!force && previous && Date.now() - previous.updatedAt < 30_000)) return this.current(previous.status);
    const diagnostic = new RemoteDiagnosticLog(connection.sshHost);
    const controller = new AbortController();
    const job = {
      status: { connectionId: id, phase: 'starting', message: 'Starting remote Michi…', diagnostic: diagnostic.report } as RemoteServiceRecoveryStatus,
      controller, done: Promise.resolve(), updatedAt: Date.now(),
    };
    this.jobs.set(id, job);
    job.done = (async () => {
      const timeout = setTimeout(() => controller.abort(new RemoteDesktopError('recovery_timeout',
        `Remote recovery timed out at ${diagnostic.report.stage} after ${this.timeoutMs / 1000} seconds. Check the captured SSH output and try again.`)), this.timeoutMs);
      let onAbort!: () => void;
      try {
        // Some SSH proxies keep their pipes open after the SSH child exits.
        // Enforce the deadline even if an underlying operation ignores abort.
        await Promise.race([
          this.setup.recover(id, controller.signal, diagnostic),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
          }),
        ]);
        diagnostic.report.message = 'Remote Michi is ready.';
        job.status = { connectionId: id, phase: 'ready', message: 'Remote Michi is ready.', diagnostic: diagnostic.report };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const remoteAuth = error instanceof RemoteDesktopError && error.code === 'remote_credentials';
        const auth = !remoteAuth && ((error instanceof RemoteDesktopError && error.code === 'ssh_auth') || isSshAuthenticationError(message));
        diagnostic.fail(error, auth ? 'ssh_auth' : error instanceof RemoteDesktopError ? error.code : 'recovery_failed');
        if (auth || remoteAuth) diagnostic.report.authentication = { scope: remoteAuth ? 'remote' : 'local', host: connection.sshHost!, user: connection.sshUser, port: connection.sshPort };
        job.status = {
          connectionId: id, phase: 'error', message: diagnostic.report.message ?? 'Remote recovery failed.', diagnostic: diagnostic.report,
          ...(diagnostic.report.authentication ? { authentication: diagnostic.report.authentication } : {}),
        };
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', onAbort);
        diagnostic.finish();
        job.updatedAt = Date.now();
      }
    })();
    return this.current(job.status);
  }

  stop(id: string): void { this.jobs.get(id)?.controller.abort(); this.jobs.delete(id); }
}
