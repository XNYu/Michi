import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Clock3, Ellipsis, Folder, Layers, Loader2, Play, Plus, Search, Sparkles, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import type { MetaAgentOverview, ScheduledJobDto, ScheduledJobRunDto } from 'michi-shared';
import { useChatActions, useChatProjects } from '../../../state/chatStore';
import type { PageId } from '../../../state/commands';
import type { Project } from '../../../state/chatTypes';
import { pageBackground } from '../../../lib/pageBackground';
import { workspaceAccent } from '../workspaceAccent';
import { isSystemWorkspace } from '../../../state/assistant/systemWorkspace';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { Button, Switch } from '../../ui/controls';
import { HoverTip } from '../../ui/Popover';
import { TrashHighlight, TrashIconButton } from './TrashControls';
import {
  getScheduledJobSettings,
  cancelScheduledJobRun,
  deleteScheduledJob,
  runScheduledJobNow,
  updateScheduledJob,
} from '../../../services/api/scheduledJobs';
import { useScheduledJobs } from '../scheduled/useScheduledJobs';
import { useBackgroundService } from '../scheduled/useBackgroundService';
import { ScheduledJobEditor, formValueFromJob, type JobFormValue } from '../scheduled/ScheduledJobEditor';
import { ScheduledJobDetail, StatusDot } from '../scheduled/ScheduledJobDetail';
import { ScheduledJobMenu } from '../scheduled/ScheduledJobMenu';
import { ScheduledBlockedExecutions } from '../scheduled/ScheduledBlockedExecutions';
import { OPEN_SCHEDULED_JOB_EVENT, takePendingScheduledJob } from '../scheduled/scheduledNav';
import { RUN_STATUS_LABELS, defaultScheduleDraft, describeSchedule, relativePastTime, relativeTime } from '../scheduled/scheduleModel';
import { openMetaAgentDetail } from '../scheduled/metaAgent/metaAgentNav';
import { pauseMetaAgentMaintenance, useMetaAgentOverview } from '../scheduled/metaAgent/useMetaAgentOverview';
// Shared row, group, search and icon-button primitives.
import './Trash.css';
import './Scheduled.css';
import '../rail/rail.css';

type EditorState = { job: ScheduledJobDto | null; initial?: JobFormValue } | null;

const SYSTEM_TASK_NAME = 'Meta agent · maintain Pages';
const NO_JOB_IDS: readonly string[] = [];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function nextRunText(job: ScheduledJobDto, now: number): { text: string; tone?: 'danger' | 'active' } {
  if (job.activeRunId) return { text: 'Running now', tone: 'active' };
  if (job.autoPaused) return { text: 'Paused after repeated failures', tone: 'danger' };
  if (!job.enabled) return { text: 'Paused' };
  // A due run waits for the scheduler's next tick (or a backend to start).
  if (job.nextRunAt) return { text: job.nextRunAt <= now ? 'Due now' : `Next ${relativeTime(job.nextRunAt, now)}` };
  return { text: 'No upcoming run' };
}

export default function TerminalScheduled({ onNav }: { onNav?: (page: PageId) => void } = {}) {
  const { projects, activeProject, hydrated } = useChatProjects();
  const { revealBackendNode } = useChatActions();
  const { jobs: allJobs, scheduler, loading, error, unavailable, refresh, upsert, remove } = useScheduledJobs();
  // Every workspace's Space maintenance job is the Meta agent's one system task, pinned above the list.
  const metaAgent = useMetaAgentOverview();
  const metaOverview = metaAgent.kind === 'ready' ? metaAgent.overview : null;
  const managedIds = metaOverview?.managedJobIds ?? NO_JOB_IDS;
  const jobs = useMemo(() => {
    const managed = new Set(managedIds);
    return allJobs.filter((job) => !managed.has(job.id));
  }, [allJobs, managedIds]);
  const [metaBusy, setMetaBusy] = useState(false);
  const service = useBackgroundService();
  const [query, setQuery] = useState('');
  const [openingEditor, setOpeningEditor] = useState(false);
  const [editor, setEditor] = useState<EditorState>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ jobId: string; anchor: HTMLButtonElement } | null>(null);
  const [busyJobs, setBusyJobs] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(Date.now);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Notification fallbacks ask for a job's details (see scheduledNav.ts).
  useEffect(() => {
    const pending = takePendingScheduledJob();
    if (pending) setDetailId(pending);
    const onOpen = (event: Event) => {
      const jobId = (event as CustomEvent<{ jobId?: string }>).detail?.jobId;
      if (jobId) { takePendingScheduledJob(); setDetailId(jobId); }
    };
    window.addEventListener(OPEN_SCHEDULED_JOB_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SCHEDULED_JOB_EVENT, onOpen);
  }, []);

  // The ⌘J assistant's hidden workspace is not a place to schedule work.
  const localProjects = useMemo(
    () => projects.filter((project) => !project.deletedAt && !project.archivedAt && !project.backendConnectionId
      && !isSystemWorkspace(project)),
    [projects],
  );
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project] as const)), [projects]);
  const defaultWorkspaceId = activeProject && localProjects.some((project) => project.id === activeProject.id)
    ? activeProject.id
    : localProjects[0]?.id ?? '';

  const needle = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return jobs;
    return jobs.filter((job) => job.name.toLocaleLowerCase().includes(needle) || job.prompt.toLocaleLowerCase().includes(needle));
  }, [jobs, needle]);
  const systemShown = !!metaOverview && (!needle || SYSTEM_TASK_NAME.toLocaleLowerCase().includes(needle));
  const groups = useMemo(() => {
    const byWorkspace = new Map<string, ScheduledJobDto[]>();
    for (const job of filtered) {
      const list = byWorkspace.get(job.workspaceId) ?? [];
      list.push(job);
      byWorkspace.set(job.workspaceId, list);
    }
    return [...byWorkspace.entries()]
      .map(([workspaceId, list]) => ({ workspaceId, project: projectById.get(workspaceId) ?? null, jobs: list }))
      .sort((a, b) => (a.project?.name ?? '~').localeCompare(b.project?.name ?? '~'));
  }, [filtered, projectById]);

  const detailJob = detailId ? jobs.find((job) => job.id === detailId) ?? null : null;
  // A request for a maintenance job's details shows the Meta agent's page instead.
  useEffect(() => {
    if (detailId && managedIds.includes(detailId)) {
      setDetailId(null);
      openMetaAgentDetail();
    }
  }, [detailId, managedIds]);
  const menuJob = menu ? jobs.find((job) => job.id === menu.jobId) ?? null : null;

  const withBusy = async (jobId: string, action: () => Promise<void>) => {
    setBusyJobs((current) => new Set(current).add(jobId));
    try {
      await action();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Something went wrong');
    } finally {
      setBusyJobs((current) => { const next = new Set(current); next.delete(jobId); return next; });
      void refresh();
    }
  };
  const runNow = (job: ScheduledJobDto) => withBusy(job.id, async () => {
    await runScheduledJobNow(job.id);
    toast.success(`Started “${job.name}”`);
  });
  const stop = (job: ScheduledJobDto) => withBusy(job.id, async () => { await cancelScheduledJobRun(job.id); });
  const setEnabled = (job: ScheduledJobDto, enabled: boolean) => withBusy(job.id, async () => {
    upsert(await updateScheduledJob(job.id, { enabled }));
  });
  const removeJob = async (job: ScheduledJobDto) => {
    // Keep the menu's trigger enabled while confirming so dismissing the
    // dialog can return focus to it. Only the delete request makes the row busy.
    const confirmed = await confirmDialog({
      title: 'Delete scheduled job?',
      message: `Delete “${job.name}”? Threads from earlier runs stay in their workspace.`,
      confirmLabel: 'Delete job',
    });
    if (!confirmed) return;
    await withBusy(job.id, async () => {
      await deleteScheduledJob(job.id);
      remove(job.id);
      if (detailId === job.id) setDetailId(null);
    });
  };
  const createJob = async () => {
    setOpeningEditor(true);
    try {
      const defaults = await getScheduledJobSettings();
      setEditor({ job: null, initial: formValueFromJob(null, { workspaceId: defaultWorkspaceId, ...defaults }) });
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : 'Could not load scheduled job defaults');
    } finally {
      setOpeningEditor(false);
    }
  };
  const duplicate = (job: ScheduledJobDto) => {
    const initial = formValueFromJob(job, { workspaceId: defaultWorkspaceId });
    const schedule = job.schedule.kind === 'at' && job.schedule.at <= Date.now() ? defaultScheduleDraft() : initial.schedule;
    setEditor({ job: null, initial: { ...initial, name: `${job.name} copy`, schedule } });
  };
  const openRun = async (run: ScheduledJobRunDto) => {
    if (!run.nodeId) return;
    const opened = await revealBackendNode(run.workspaceId, run.nodeId);
    if (!opened) toast.error('That thread is no longer available');
    else setDetailId(null);
  };
  const setMetaPaused = (paused: boolean) => {
    setMetaBusy(true);
    pauseMetaAgentMaintenance(paused)
      .catch((reason: unknown) => { toast.error(reason instanceof Error ? reason.message : 'Something went wrong'); })
      .finally(() => setMetaBusy(false));
  };
  const enableService = async () => {
    const confirmed = await confirmDialog({
      title: 'Keep Michi running in the background?',
      message: 'Michi’s backend will keep running after you quit the app and start when you log in, so scheduled jobs run on time. Open chats reconnect in a moment.',
      confirmLabel: 'Keep running',
    });
    if (confirmed) await service.setEnabled(true);
  };

  const serviceRunning = !!service.status?.running || !!scheduler?.serviceMode;
  const total = jobs.length;
  const runsBlocked = !!scheduler?.blockedExecutions?.length;
  const subtitle = serviceRunning
    ? 'Runs in the background, even when Michi is closed'
    : service.available ? 'Runs while Michi is open' : 'Runs while the Michi server is running';

  return (
    <div className="terminal-scheduled term-scrollbar" style={{ background: pageBackground('scheduled') }} aria-busy={loading || !hydrated}>
      <div className="sched-content">
        <header className="sched-heading">
          <div>
            <div className="sched-heading-title"><h1>Scheduled</h1>{total > 0 && <span aria-label={plural(total, 'job')}>{total}</span>}</div>
            <p className="sched-subtitle"><Clock3 size={13} aria-hidden="true" />{subtitle}</p>
          </div>
          <Button variant="primary" size="sm" disabled={unavailable || localProjects.length === 0 || openingEditor} onClick={() => void createJob()}>
            <Plus size={14} aria-hidden="true" />New job
          </Button>
        </header>

        <ScheduledBlockedExecutions executions={scheduler?.blockedExecutions ?? []} jobs={jobs}
          workspaceName={(workspaceId) => projectById.get(workspaceId)?.name ?? 'Unavailable workspace'} now={now} onReleased={refresh} />

        {service.available && service.status?.supported && !service.status.running && total > 0 && (
          <div className="sched-banner" role="note">
            <span>Jobs only run while Michi is open. Keep Michi running in the background so they run on schedule.</span>
            <Button size="sm" disabled={service.busy} onClick={() => { void enableService(); }}>
              {service.busy ? 'Starting…' : 'Run in background'}
            </Button>
          </div>
        )}
        {service.error && <div className="sched-error" role="alert"><span>{service.error}</span></div>}

        {total > 0 && (
          <div className="sched-toolbar">
            <label className="trash-search"><Search size={14} aria-hidden="true" />
              <input ref={search} type="search" aria-label="Search scheduled jobs" placeholder="Search jobs..."
                value={query} onChange={(event) => setQuery(event.target.value)} />
              {query && <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); search.current?.focus(); }}><X size={14} aria-hidden="true" /></button>}
            </label>
            <span className="sched-result-count" role="status">{needle ? plural(filtered.length + (systemShown ? 1 : 0), 'result') : ''}</span>
          </div>
        )}

        {error && <div className="sched-error" role="alert"><span>Could not load scheduled jobs: {error}</span>
          <Button size="sm" variant="ghost" onClick={() => { void refresh(); }}>Retry</Button></div>}

        {loading || !hydrated ? (
          <div className="sched-loading" role="status" aria-label="Loading scheduled jobs"><span /><span /><span /></div>
        ) : unavailable ? (
          <div className="sched-empty">
            <CalendarClock size={30} aria-hidden="true" />
            <h2>Scheduled jobs are not available</h2>
            <p>This Michi server does not run scheduled jobs.</p>
          </div>
        ) : <>
        {systemShown && metaOverview && (
          <section className="trash-group" aria-label="System task">
            <h2 className="trash-group-heading">
              <Layers size={15} aria-hidden="true" />
              <span className="trash-group-name">All workspaces</span>
            </h2>
            <div className="trash-group-rows">
              <SystemTaskRow overview={metaOverview} now={now} query={query} busy={metaBusy}
                onOpen={() => openMetaAgentDetail()} onToggle={(on) => setMetaPaused(!on)} />
            </div>
          </section>
        )}
        {total === 0 ? (
          <div className="sched-empty">
            <CalendarClock size={30} aria-hidden="true" />
            <h2>{systemShown ? 'No jobs of your own yet' : 'No scheduled jobs'}</h2>
            <p>Run a prompt on a schedule. Results appear in the job’s conversation, and Michi lets you know when it finishes.</p>
            {localProjects.length > 0
              ? <Button size="sm" disabled={openingEditor} onClick={() => void createJob()}><Plus size={14} aria-hidden="true" />New job</Button>
              : <Button size="sm" variant="ghost" onClick={() => onNav?.('workspaces')}>Create a workspace first</Button>}
          </div>
        ) : filtered.length === 0 ? (systemShown ? null : (
          <div className="sched-empty">
            <Search size={30} aria-hidden="true" />
            <h2>No matching jobs</h2>
            <p>Nothing matches “{query.trim()}”.</p>
          </div>
        )) : groups.map((group) => (
          <section className="trash-group" key={group.workspaceId}>
            <h2 className="trash-group-heading">
              <Folder size={15} aria-hidden="true" style={{ color: group.project ? workspaceAccent(group.project.id) : undefined }} />
              <span className="trash-group-name">{group.project?.name ?? 'Unavailable workspace'}</span>
              <span className="trash-group-count">{group.jobs.length}</span>
            </h2>
            <div className="trash-group-rows">
              {group.jobs.map((job) => (
                <JobRow key={job.id} job={job} now={now} query={query} busy={busyJobs.has(job.id)} runBlocked={runsBlocked}
                  menuOpen={menu?.jobId === job.id}
                  onOpen={() => setDetailId(job.id)}
                  onRunNow={() => { void runNow(job); }}
                  onStop={() => { void stop(job); }}
                  onToggle={(enabled) => { void setEnabled(job, enabled); }}
                  onMenu={(anchor) => setMenu((current) => current?.jobId === job.id ? null : { jobId: job.id, anchor })} />
              ))}
            </div>
          </section>
        ))}
        </>}
      </div>

      {menu && menuJob && (
        <ScheduledJobMenu anchor={menu.anchor} paused={!menuJob.enabled || menuJob.autoPaused} onClose={() => setMenu(null)} actions={{
          onEdit: () => setEditor({ job: menuJob }),
          onRuns: () => setDetailId(menuJob.id),
          onToggle: () => { void setEnabled(menuJob, !menuJob.enabled || menuJob.autoPaused); },
          onDuplicate: () => duplicate(menuJob),
          onDelete: () => { void removeJob(menuJob); },
        }} />
      )}
      {detailJob && !editor && (
        <ScheduledJobDetail job={detailJob} now={now} busy={busyJobs.has(detailJob.id)} runBlocked={runsBlocked}
          workspaceName={projectById.get(detailJob.workspaceId)?.name ?? 'Unavailable workspace'}
          onClose={() => setDetailId(null)}
          onEdit={() => setEditor({ job: detailJob })}
          onRunNow={() => { void runNow(detailJob); }}
          onCancelRun={() => { void stop(detailJob); }}
          onDelete={() => { void removeJob(detailJob); }}
          onOpenRun={(run) => { void openRun(run); }} />
      )}
      {editor && (
        <ScheduledJobEditor job={editor.job} initial={editor.initial} projects={editorProjects(localProjects, editor.job, projectById)}
          defaultWorkspaceId={defaultWorkspaceId}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            upsert(saved);
            setEditor(null);
            toast.success(editor.job ? 'Job saved' : `Scheduled “${saved.name}”`);
            void refresh();
          }} />
      )}
    </div>
  );
}

/** Keep an edited job's (now archived) workspace selectable. */
function editorProjects(local: Project[], job: ScheduledJobDto | null, byId: Map<string, Project>): Project[] {
  if (!job || local.some((project) => project.id === job.workspaceId)) return local;
  const current = byId.get(job.workspaceId);
  return current ? [current, ...local] : local;
}

function JobRow({ job, now, query, busy, runBlocked, menuOpen, onOpen, onRunNow, onStop, onToggle, onMenu }: {
  job: ScheduledJobDto;
  now: number;
  query: string;
  busy: boolean;
  runBlocked: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onRunNow: () => void;
  onStop: () => void;
  onToggle: (enabled: boolean) => void;
  onMenu: (anchor: HTMLButtonElement) => void;
}) {
  const next = nextRunText(job, now);
  const running = !!job.activeRunId;
  const active = job.enabled && !job.autoPaused;
  return (
    <article className="trash-row sched-row" data-paused={!active || undefined}>
      <button type="button" className="trash-row-open" aria-label={`Open ${job.name}`} onClick={onOpen}>
        <span className="trash-row-icon">
          {running ? <Loader2 size={16} className="sched-spin" aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}
        </span>
        <span className="trash-row-content">
          <span className="trash-row-title"><TrashHighlight text={job.name} query={query} /></span>
          <span className="trash-row-meta">
            <span>{describeSchedule(job.schedule)}</span>
            <span className="sched-next" data-tone={next.tone}><span aria-hidden="true"> · </span>{next.text}</span>
          </span>
        </span>
      </button>
      <div className="sched-last" title={job.lastError ?? undefined}>
        {running || job.lastStatus ? (
          <>
            {/* lastRunAt is stamped when a run starts, so an active run owns it. */}
            {running
              ? <span className="sched-last-status"><StatusDot status="running" />{RUN_STATUS_LABELS.running}</span>
              : job.lastStatus && <span className="sched-last-status"><StatusDot status={job.lastStatus} />{RUN_STATUS_LABELS[job.lastStatus]}</span>}
            {job.lastRunAt && <span className="sched-last-time">{relativePastTime(job.lastRunAt, now)}</span>}
          </>
        ) : <span className="sched-last-time">Never run</span>}
      </div>
      <div className="trash-row-actions">
        {running
          ? <TrashIconButton icon={Square} tooltip="Stop run" aria-label={`Stop ${job.name}`} disabled={busy} onClick={onStop} />
          : <TrashIconButton icon={Play} tooltip={runBlocked ? 'Confirm the previous execution has stopped first' : 'Run now'} aria-label={`Run ${job.name} now`} disabled={busy || runBlocked} onClick={onRunNow} />}
        <span className="sched-switch">
          <Switch on={active} disabled={busy} onChange={onToggle} aria-label={active ? `Pause ${job.name}` : `Resume ${job.name}`} />
        </span>
        <TrashIconButton icon={Ellipsis} tooltip="More actions" aria-label={`More actions for ${job.name}`}
          aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy} onClick={(event) => onMenu(event.currentTarget)} />
      </div>
    </article>
  );
}

/** The Meta agent's background maintenance as one row: it can be paused, not run, edited or deleted here. */
function SystemTaskRow({ overview, now, query, busy, onOpen, onToggle }: {
  overview: MetaAgentOverview;
  now: number;
  query: string;
  busy: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const active = overview.state !== 'paused';
  const workspaces = overview.cursors.length;
  const lastRun = overview.recentRuns[0] ?? null;
  return (
    <article className="trash-row sched-row" data-paused={!active || undefined} data-system="">
      <button type="button" className="trash-row-open" aria-label={`Open ${SYSTEM_TASK_NAME}`} onClick={onOpen}>
        <span className="trash-row-icon">
          {lastRun?.state === 'running' ? <Loader2 size={16} className="sched-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
        </span>
        <span className="trash-row-content">
          <span className="trash-row-title"><TrashHighlight text={SYSTEM_TASK_NAME} query={query} /> <span className="area-side__tag">System</span></span>
          <span className="trash-row-meta">
            <span>Every 60 s</span>
            <span className="sched-next" data-tone={overview.state === 'error' ? 'danger' : undefined}>
              <span aria-hidden="true"> · </span>
              {overview.state === 'error' ? 'Error' : !active ? 'Paused' : workspaces === 0 ? 'No workspace yet' : plural(workspaces, 'workspace')}
            </span>
          </span>
        </span>
      </button>
      <div className="sched-last" title={overview.error}>
        {lastRun
          ? <span className="sched-last-time">{relativePastTime(lastRun.at, now)}</span>
          : <span className="sched-last-time">Never run</span>}
      </div>
      {/* Empty slots where a job's Run and More buttons sit, so the switches line up. */}
      <div className="trash-row-actions">
        <span className="trash-icon-button" aria-hidden="true" style={{ visibility: 'hidden' }} />
        <HoverTip label={active ? 'Pause background updates' : 'Resume background updates'}>
          <span className="sched-switch">
            <Switch on={active} disabled={busy} onChange={onToggle}
              aria-label={active ? 'Pause background updates' : 'Resume background updates'} />
          </span>
        </HoverTip>
        <span className="trash-icon-button" aria-hidden="true" style={{ visibility: 'hidden' }} />
      </div>
    </article>
  );
}
