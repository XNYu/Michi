import { useCallback, useEffect, useRef, useState } from 'react';
import type { SelfUpdateCheck, SelfUpdateJob, SelfUpdateStatus } from 'michi-shared';
import { Button } from '../../../ui/controls';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import {
  SelfUpdateRequestError, checkSelfUpdate, fetchSelfUpdate, startSelfUpdate,
} from '../../../../services/api/selfUpdate';
import { SettingsRow, SettingsSection } from './SettingsSection';
import './selfUpdate.css';

const short = (revision: string | null | undefined) => revision ? revision.slice(0, 7) : 'unknown';
const POLL_MS = 2500;
const UNREACHABLE_POLL_MS = 4000;
/** How long a restart may keep Michi unreachable before the page says so. */
const RESTART_PATIENCE_MS = 10 * 60_000;
const RELOAD_DELAY_MS = 1500;

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Could not reach Michi.';
}

/**
 * Settings → Update on a phone: checks the machine's source branch (dev) for
 * commits this build lacks and, once confirmed, has the machine run
 * `michi update`, which builds beside the running backend and then switches
 * to it. The page follows the update through the restart and reloads into the
 * new version.
 */
export function UpdatePane({ reload = () => window.location.reload() }: { reload?: () => void } = {}) {
  const [status, setStatus] = useState<SelfUpdateStatus | null>(null);
  const [check, setCheck] = useState<SelfUpdateCheck | null>(null);
  const [job, setJob] = useState<SelfUpdateJob | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [unreachableSince, setUnreachableSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  // This page followed an update (rather than finding an old outcome), so it shows the outcome and reloads.
  const [watched, setWatched] = useState(false);
  const mounted = useRef(true);
  const follow = useCallback((next: SelfUpdateJob) => {
    setJob(next);
    if (next.phase === 'running') setWatched(true);
  }, []);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchSelfUpdate(controller.signal).then((next) => {
      setStatus(next);
      if (next.job) follow(next.job);
    }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [follow]);

  // Follow a running update. The backend stops while it switches builds, so
  // failed reads mean "restarting" until the new backend reports the outcome.
  const following = job?.phase === 'running' ? job.id : null;
  useEffect(() => {
    if (!following) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let delay = POLL_MS;
      try {
        const next = await fetchSelfUpdate(controller.signal);
        if (controller.signal.aborted) return;
        setStatus(next);
        setUnreachableSince(null);
        if (next.job?.id === following) {
          setJob(next.job);
          if (next.job.phase !== 'running') return;
        }
      } catch {
        if (controller.signal.aborted) return;
        setUnreachableSince((since) => since ?? Date.now());
        setNow(Date.now());
        delay = UNREACHABLE_POLL_MS;
      }
      timer = setTimeout(() => { void poll(); }, delay);
    };
    timer = setTimeout(() => { void poll(); }, POLL_MS);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [following]);

  // The new build is serving: load its UI.
  const switched = job?.phase === 'succeeded' && !!status && status.current.revision !== job.from;
  useEffect(() => {
    if (!switched || !watched) return;
    const timer = setTimeout(reload, RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [switched, watched, reload]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    // A new check replaces an earlier outcome.
    setJob((previous) => previous?.phase === 'running' ? previous : null);
    try {
      const next = await checkSelfUpdate();
      if (!mounted.current) return;
      setCheck(next);
      setStatus(next);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, []);

  const update = async () => {
    if (!check) return;
    const ok = await confirmDialog({
      title: 'Update Michi now?',
      message: `This machine builds ${check.branch} ${short(check.latest)}, then restarts Michi. Chats still running when it restarts are interrupted. This page reloads when the new version is ready.`,
      confirmLabel: 'Update',
      danger: false,
    });
    if (!ok || !mounted.current) return;
    setStarting(true);
    setError(null);
    try {
      const started = await startSelfUpdate(check.latest);
      if (mounted.current) follow(started);
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof SelfUpdateRequestError && reason.code === 'running' && reason.job) follow(reason.job);
      else {
        if (reason instanceof SelfUpdateRequestError && reason.check) setCheck(reason.check);
        setError(errorMessage(reason));
      }
    } finally {
      if (mounted.current) setStarting(false);
    }
  };

  const current = status?.current;
  const running = job?.phase === 'running';
  const busy = checking || starting || running;
  return <>
    <SettingsSection title="Michi on this machine" className="self-update">
      {!status && !error && <p className="settings-section__status" role="status">Loading…</p>}
      {status && <SettingsRow
        label="Running"
        description={<span className="self-update__build">{current?.version} · <code>{short(current?.revision)}</code>{current?.dirty ? ' · local changes' : ''}</span>}
        control={status.supported && <Button size="sm" disabled={busy} onClick={() => { void runCheck(); }}>
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>}>
        {!status.supported && <p className="settings-row__note">{status.reason}</p>}
        {status.supported && !check && !job && <p className="settings-row__note">Updates follow the {status.branch} branch.</p>}
        {check?.state === 'current' && !running && <p className="settings-row__note" role="status">
          Up to date with {check.branch} ({short(check.latest)}).
        </p>}
      </SettingsRow>}
      {error && <p className="settings-section__error" role="alert">{error}</p>}
    </SettingsSection>

    {check?.state === 'available' && !running && job?.phase !== 'succeeded' && (
      <SettingsSection title="Update available" className="self-update"
        aside={`${check.total} new ${check.total === 1 ? 'commit' : 'commits'}`}>
        <ol className="self-update__commits" aria-label={`New on ${check.branch}`}>
          {check.commits.map((commit) => <li key={commit.revision}>
            <code>{short(commit.revision)}</code><span>{commit.subject}</span>
          </li>)}
        </ol>
        {check.total > check.commits.length && <p className="settings-row__note">And {check.total - check.commits.length} more.</p>}
        {check.blocked ? <p className="settings-row__note" role="alert">{check.blocked}</p> : (
          <div className="self-update__actions">
            <Button variant="primary" disabled={busy} onClick={() => { void update(); }}>{starting ? 'Starting…' : 'Update now'}</Button>
          </div>
        )}
      </SettingsSection>
    )}

    {job && (running || watched || job.phase === 'failed') && <JobSection job={job} switched={switched && watched}
      unreachable={running && unreachableSince !== null} late={running && unreachableSince !== null && now - unreachableSince > RESTART_PATIENCE_MS}
      onRetry={busy ? undefined : () => { void runCheck(); }} />}
  </>;
}

function JobSection({ job, switched, unreachable, late, onRetry }: {
  job: SelfUpdateJob;
  switched: boolean;
  unreachable: boolean;
  late: boolean;
  onRetry?: () => void;
}) {
  if (job.phase === 'running') {
    const headline = unreachable ? 'Michi is restarting…'
      : job.stage === 'switching' ? 'Switching to the new build. Running chats are interrupted.'
        : `Building ${short(job.target)} beside the running Michi. This takes a few minutes; you can keep chatting.`;
    return <SettingsSection title="Updating" className="self-update">
      <p className="settings-row__note" role="status">{headline}</p>
      {!unreachable && <p className="settings-row__note self-update__detail">{job.message}</p>}
      {late && <p className="settings-row__note" role="alert">
        Michi has not come back for 10 minutes. On the machine, run michi status, or see {job.logFile}.
      </p>}
    </SettingsSection>;
  }
  if (job.phase === 'succeeded') {
    return <SettingsSection title="Updated" className="self-update">
      <p className="settings-row__note" role="status">{switched ? `${job.message}. Reloading…` : job.message}</p>
    </SettingsSection>;
  }
  return <SettingsSection title="Update failed" className="self-update">
    <p className="settings-row__note" role="alert">{job.message}</p>
    <p className="settings-row__note self-update__detail">Details are in {job.logFile} on the machine.</p>
    {onRetry && <div className="self-update__actions"><Button size="sm" onClick={onRetry}>Check again</Button></div>}
  </SettingsSection>;
}
