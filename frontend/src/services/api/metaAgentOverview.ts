import type { MetaAgentOverview } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { responseError } from './httpError';

// Scheduled › Meta agent, served by the local backend's `/api/meta-agent/overview`.
// A backend without the route answers 404; callers show that as unavailable.

const base = () => `${backendApiBase()}/meta-agent`;

async function overview(response: Response, operation: string): Promise<MetaAgentOverview> {
  if (!response.ok) throw await responseError(response, operation);
  return await response.json() as MetaAgentOverview;
}

export async function fetchMetaAgentOverview(signal?: AbortSignal): Promise<MetaAgentOverview> {
  return overview(await fetch(`${base()}/overview`, { signal }), 'fetchMetaAgentOverview');
}

/** Pauses or resumes background maintenance in every workspace; answers the overview after the change. */
export async function setMetaAgentPaused(paused: boolean): Promise<MetaAgentOverview> {
  return overview(await fetch(`${base()}/${paused ? 'pause' : 'resume'}`, { method: 'POST' }), paused ? 'pauseMetaAgent' : 'resumeMetaAgent');
}
