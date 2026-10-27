import React, { useMemo } from 'react';
import { Clock, Loader2, Sparkles } from 'lucide-react';
import { useChatProjects } from '../../../state/chatStore';
import { SETTINGS_AREA_SECTIONS, type SettingsAreaSection } from '../../../state/shellArea';
import { useScheduledJobs } from '../scheduled/useScheduledJobs';
import { describeSchedule } from '../scheduled/scheduleModel';
import { closeMetaAgentDetail, openMetaAgentDetail, useMetaAgentDetailOpen } from '../scheduled/metaAgent/metaAgentNav';
import { useMetaAgentOverview, type MetaAgentOverviewLoad } from '../scheduled/metaAgent/useMetaAgentOverview';
import { useMetaAgentSnapshot } from '../../../state/metaAgent/useMetaAgent';
import { metaAgentStatus } from '../../../state/metaAgent/metaAgentStatus';
import type { MetaAgentInfo } from '../../../services/api/metaAgent';

function rowKeys(action: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    action();
  };
}

/** The system row's sub-line: what the Meta agent's background maintenance is doing now. */
function systemSubline(load: MetaAgentOverviewLoad, info: MetaAgentInfo | null): string {
  if (load.kind === 'loading') return 'Every 60 s';
  if (load.kind !== 'ready') return load.kind === 'unavailable' ? 'Not set up yet' : 'Status unavailable';
  const { cursors } = load.overview;
  // The same status the Spaces sidebar, the Home and the detail page read.
  const { kind } = metaAgentStatus({ info, overview: load.overview });
  if (kind === 'stopped' || kind === 'guard-failed') return 'Error';
  if (kind === 'not-running' || kind === 'unsupported') return 'Not running';
  if (kind === 'paused') return 'Paused';
  if (cursors.length === 0) return 'Running · no workspace yet';
  const waiting = cursors.filter((cursor) => cursor.state === 'next').length;
  return waiting > 0 ? `Running · ${waiting} need${waiting === 1 ? 's' : ''} reading`
    : `Running · ${cursors.length} ${cursors.length === 1 ? 'workspace' : 'workspaces'}`;
}

/**
 * Scheduled area sidebar: the Meta agent's system task pinned first, then every
 * ordinary job. The per-workspace managed maintenance jobs are that one system
 * task, so they are not listed again.
 */
export function ScheduledSidebar({ selectedJobId, onSelectJob, onNavigate, systemTask }: {
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
  /** After a row opened its page in the main column. */
  onNavigate?: () => void;
  /** The Meta agent's maintenance task; a placeholder row until it exists. */
  systemTask?: React.ReactNode;
}) {
  const { jobs, loading, unavailable } = useScheduledJobs();
  const descriptionId = React.useId();
  const { projects } = useChatProjects();
  const overview = useMetaAgentOverview();
  const agent = useMetaAgentSnapshot();
  const names = useMemo(() => new Map(projects.map((project) => [project.id, project.name] as const)), [projects]);
  const managed = overview.kind === 'ready' ? overview.overview.managedJobIds : undefined;
  const sorted = useMemo(() => {
    const hidden = new Set(managed ?? []);
    return jobs.filter((job) => !hidden.has(job.id)).sort((a, b) => a.name.localeCompare(b.name));
  }, [jobs, managed]);
  const metaAgentOpen = useMetaAgentDetailOpen();
  const openMetaAgent = () => { openMetaAgentDetail(selectedJobId); onNavigate?.(); };
  return (
    <div className="area-side scheduled-side" aria-label="Scheduled jobs">
      <div className="area-side__grow term-scrollbar">
        <div className="area-side__section">Scheduled</div>
        {systemTask ?? (
          <div className="area-side__item" data-pinned="">
            <div className="area-side__row is-strong" role="button" tabIndex={0} aria-current={metaAgentOpen ? 'true' : undefined}
              aria-label="Meta agent · maintain Pages System" aria-describedby={`${descriptionId}-system`}
              onClick={openMetaAgent} onKeyDown={rowKeys(openMetaAgent)}>
              <Sparkles size={15} strokeWidth={1.5} aria-hidden="true" />
              <span className="area-side__text">
                <span className="area-side__label">Meta agent · maintain Pages</span>
                <span className="area-side__sub" id={`${descriptionId}-system`}>{systemSubline(overview, agent.info)}</span>
              </span>
              <span className="area-side__tag">System</span>
            </div>
          </div>
        )}
        {loading && jobs.length === 0 && <div className="area-side__note" role="status">Loading jobs…</div>}
        {unavailable && <div className="area-side__note">This Michi server does not run scheduled jobs.</div>}
        {sorted.map((job) => {
          const current = !metaAgentOpen && job.id === selectedJobId;
          const select = () => { closeMetaAgentDetail(); onSelectJob(job.id); onNavigate?.(); };
          return (
            <div className="area-side__item" key={job.id}>
              <div className="area-side__row is-strong" role="button" tabIndex={0} aria-current={current ? 'true' : undefined} onClick={select} onKeyDown={rowKeys(select)}
                aria-label={job.name} aria-describedby={`${descriptionId}-${job.id}`}>
                {job.activeRunId
                  ? <Loader2 size={15} strokeWidth={1.5} className="area-side__spin" aria-hidden="true" />
                  : <Clock size={15} strokeWidth={1.5} aria-hidden="true" />}
                <span className="area-side__text">
                  <span className="area-side__label">{job.name}</span>
                  <span className="area-side__sub" id={`${descriptionId}-${job.id}`}>{describeSchedule(job.schedule)}{names.get(job.workspaceId) ? ` · ${names.get(job.workspaceId)}` : ''}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Settings area sidebar: one row per section. */
export function SettingsSidebar({ section, onSelect }: {
  section: SettingsAreaSection;
  onSelect: (section: SettingsAreaSection) => void;
}) {
  return (
    <nav className="area-side" aria-label="Settings sections">
      <div className="area-side__grow term-scrollbar">
        <div className="area-side__section">Settings</div>
        {SETTINGS_AREA_SECTIONS.map(({ id, label }) => (
          <div
            key={id}
            className="area-side__row is-strong is-flat"
            role="button"
            tabIndex={0}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => onSelect(id)}
            onKeyDown={rowKeys(() => onSelect(id))}
          >
            <span className="area-side__label">{label}</span>
          </div>
        ))}
      </div>
    </nav>
  );
}
