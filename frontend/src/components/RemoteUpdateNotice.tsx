import { useCallback, useEffect, useRef, useState } from 'react';
import type { RemoteConnectionDiagnostic, RemoteUpdateJob, RemoteUpdateStatus } from 'michi-shared';
import { checkRemoteVersion, fetchRemoteUpdate, updateRemoteBackend } from '../services/api/remoteUpdate';
import { requestRemoteAuthentication } from '../state/remoteAuthentication';
import { RemoteDiagnostics } from './RemoteDiagnostics';
import { Button } from './ui/controls';
import './RemoteConnection.css';

/** While the gateway reports a running update this view did not start, read it again this often. */
export const REMOTE_UPDATE_POLL_MS = 1000;
const UP_TO_DATE = 'Remote Michi is up to date.';

/** What this view shows about the latest update attempt. */
interface UpdateView {
  phase: RemoteUpdateJob['phase'];
  message: string;
  diagnostic?: RemoteConnectionDiagnostic | null;
}

const fromJob = (job: RemoteUpdateJob): UpdateView => ({ phase: job.phase, message: job.message, diagnostic: job.diagnostic ?? null });
const errorMessage = (failure: unknown) => failure instanceof Error ? failure.message : String(failure);

export function RemoteUpdateNotice({ connectionId, name, onUpdated }: { connectionId: string; name: string; onUpdated?: () => void }) {
  const [status, setStatus] = useState<RemoteUpdateStatus | null>(null);
  const [checkError, setCheckError] = useState('');
  const [view, setView] = useState<UpdateView | null>(null);
  // True while this view follows a gateway-owned update instead of its own stream.
  const [following, setFollowing] = useState(false);
  const [sendingDiagnostic, setSendingDiagnostic] = useState(false);
  const [check, setCheck] = useState(0);
  const [retry, setRetry] = useState(0);
  const stream = useRef<AbortController | null>(null);
  const started = useRef(false);
  // A verified update result supersedes a version check that began before it.
  const settled = useRef(false);
  const onUpdatedRef = useRef(onUpdated);
  useEffect(() => { onUpdatedRef.current = onUpdated; }, [onUpdated]);

  useEffect(() => {
    const controller = new AbortController();
    started.current = false; settled.current = false;
    setStatus(null); setCheckError(''); setView(null); setFollowing(false);
    // Closing Settings or switching panes detaches progress, not the update.
    // Show the gateway's attempt rather than offering a duplicate.
    void fetchRemoteUpdate(connectionId, controller.signal).then(job => {
      if (controller.signal.aborted || !job || started.current) return;
      setView(fromJob(job)); setFollowing(job.phase === 'running');
    }).catch(() => { /* Without update state, the version check still decides. */ });
    void checkRemoteVersion(connectionId, controller.signal).then(value => {
      if (!controller.signal.aborted && !settled.current) setStatus(value);
    }).catch(failure => {
      if (!controller.signal.aborted && !settled.current) setCheckError(errorMessage(failure));
    });
    return () => { controller.abort(); stream.current?.abort(); };
  }, [connectionId, check]);

  // Only an outcome this view saw happen refreshes the caller or asks for
  // sign-in. Reopening on an earlier outcome just shows it.
  const settle = useCallback((next: UpdateView, result?: RemoteUpdateStatus) => {
    setView(next); setFollowing(false);
    if (next.phase === 'succeeded') {
      if (result) { settled.current = true; setStatus(result); setCheckError(''); }
      onUpdatedRef.current?.();
    } else if (next.diagnostic?.authentication) {
      requestRemoteAuthentication({ key: `update:${connectionId}`, target: next.diagnostic.authentication, connectionId });
    }
  }, [connectionId]);

  useEffect(() => {
    if (!following || view?.phase !== 'running') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetchRemoteUpdate(connectionId, controller.signal).then(job => {
        if (controller.signal.aborted) return;
        // The gateway restarted and lost the attempt: check the version afresh.
        if (!job) setCheck(value => value + 1);
        else if (job.phase === 'running') setView(fromJob(job));
        else settle(fromJob(job), job.result);
      }).catch(() => { if (!controller.signal.aborted) setRetry(value => value + 1); });
    }, REMOTE_UPDATE_POLL_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [connectionId, following, view, retry, settle]);

  const update = async () => {
    if (view?.phase === 'running' || sendingDiagnostic) return;
    const controller = new AbortController(); stream.current = controller; started.current = true;
    setFollowing(false); setView({ phase: 'running', message: 'Preparing remote update…' });
    try {
      const updated = await updateRemoteBackend(connectionId, name, message => {
        if (!controller.signal.aborted) setView({ phase: 'running', message });
      }, controller.signal);
      if (controller.signal.aborted) return;
      settle({ phase: 'succeeded', message: UP_TO_DATE }, updated);
    } catch (failure) {
      if (controller.signal.aborted) return;
      const diagnostic = (failure as { diagnostic?: RemoteConnectionDiagnostic })?.diagnostic ?? null;
      // The request can fail while the gateway still owns an update: one
      // started from another view (409), or a dropped progress stream.
      const job = await fetchRemoteUpdate(connectionId, controller.signal).catch(() => null);
      if (controller.signal.aborted) return;
      if (job?.phase === 'running') { setView(fromJob(job)); setFollowing(true); }
      else if (job && job.attemptId === diagnostic?.id) settle(fromJob(job), job.result);
      else settle({ phase: 'failed', message: errorMessage(failure), diagnostic });
    }
  };

  const running = view?.phase === 'running';
  const older = status?.state === 'older';
  // A finished attempt only explains the version it left behind.
  const succeeded = view?.phase === 'succeeded' && status?.state === 'current';
  const failed = view?.phase === 'failed' && status?.state !== 'current' ? view : null;
  const progress = running ? view.message : succeeded ? UP_TO_DATE : '';
  const showCheckError = !!checkError && !status && !running;
  if (!older && !running && !progress && !failed && !showCheckError) return null;
  return <div className="remote-update" aria-label={`Michi update for ${name}`} aria-busy={running}>
    {older ? <>
      <p className="remote-update__heading">Remote Michi is older than this app</p>
      <p className="remote-update__versions">Remote {status.remote?.revision?.slice(0, 7)} · This app {status.local.revision?.slice(0, 7)}</p>
    </> : (running || failed) && <p className="remote-update__heading">{running ? 'Updating remote Michi' : 'Remote Michi update failed'}</p>}
    {running || (older && status.canUpdate) ? <>
      <p>Update to this app’s version. Michi builds first, then restarts the remote service. Running chats will be interrupted.</p>
      <Button size="sm" disabled={running || sendingDiagnostic} onClick={() => { void update(); }}>{running ? 'Updating…' : 'Update remote Michi'}</Button>
    </> : older && <p>{status.message}</p>}
    {progress && <p role="status" aria-live="polite">{progress}</p>}
    {failed && <p role="alert" className="remote-connection-notice" data-tone="error">{failed.message}</p>}
    {showCheckError && <>
      <p role="alert" className="remote-connection-notice" data-tone="error">{checkError}</p>
      <Button size="sm" variant="ghost" onClick={() => setCheck(value => value + 1)}>Check version again</Button>
    </>}
    {failed?.diagnostic && <RemoteDiagnostics key={failed.diagnostic.id} report={failed.diagnostic} onBusyChange={setSendingDiagnostic} />}
  </div>;
}
