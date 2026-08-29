import React from 'react';
import { AgentDefinitionStatus, AgentRunStatus } from 'michi-shared';
import type { AgentDefinitionDtoV1, AgentRunDtoV1 } from 'michi-shared';
import type { AgentResourceIdentity, LocatedAgentResource } from '../../../state/agentIdentity';

interface Props {
  definitions: Array<LocatedAgentResource<AgentDefinitionDtoV1>>;
  runs?: Array<LocatedAgentResource<AgentRunDtoV1>>;
  workspaceId?: string | null;
  loading?: boolean;
  error?: string | null;
  onCreate: (scope: 'workspace' | 'global') => void;
  onEdit: (resource: LocatedAgentResource<AgentDefinitionDtoV1>) => void;
  onEnable: (identity: AgentResourceIdentity) => void;
  onDisable: (identity: AgentResourceIdentity) => void;
  onDuplicate: (identity: AgentResourceIdentity) => void;
  onDelete: (identity: AgentResourceIdentity) => void;
}

const activeStatuses = new Set<AgentRunStatus>([AgentRunStatus.Queued, AgentRunStatus.Preparing, AgentRunStatus.Running, AgentRunStatus.Waiting, AgentRunStatus.Recovering]);

export default function AgentLibraryPage({ definitions, runs = [], workspaceId = null, loading = false, error, onCreate, onEdit, onEnable, onDisable, onDuplicate, onDelete }: Props) {
  const workspace = definitions.filter((resource) => resource.value.scope === 'workspace' && (!workspaceId || resource.value.workspaceId === workspaceId));
  const global = definitions.filter((resource) => resource.value.scope === 'global');
  const activeCount = (resource: LocatedAgentResource<AgentDefinitionDtoV1>) => runs.filter((run) => run.backendConnectionId === resource.backendConnectionId && run.value.definitionId === resource.value.id && activeStatuses.has(run.value.status)).length;
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', background: 'var(--term-page-bg, var(--term-bg))', color: 'var(--term-fg)', padding: '28px 56px 72px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, marginBottom: 28 }}>
        <div><div style={eyebrowStyle}>Custom agents</div><h1 style={{ margin: '6px 0 4px', fontFamily: 'var(--ui-font)', fontSize: 36, lineHeight: 1.1, fontWeight: 500 }}>Agent Library</h1><p style={{ margin: 0, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 12 }}>Reusable capabilities stay separate from conversation branches and Runs.</p></div>
        <div style={{ display: 'flex', gap: 8 }}><button type="button" onClick={() => onCreate('workspace')} style={buttonStyle}>+ workspace agent</button><button type="button" onClick={() => onCreate('global')} style={buttonStyle}>+ global agent</button></div>
      </header>
      {error && <div role="alert" style={{ color: 'var(--danger, var(--term-error))', border: '1px solid var(--danger, var(--term-error))', padding: 10, marginBottom: 16, fontFamily: 'var(--ui-font)', fontSize: 12 }}>{error}</div>}
      {loading && definitions.length === 0 ? <div style={emptyStyle}>loading agent library…</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
          <LibrarySection title="WORKSPACE AGENTS" scope="workspace" resources={workspace} activeCount={activeCount} onEdit={onEdit} onEnable={onEnable} onDisable={onDisable} onDuplicate={onDuplicate} onDelete={onDelete} />
          <LibrarySection title="GLOBAL AGENTS" scope="global" resources={global} activeCount={activeCount} onEdit={onEdit} onEnable={onEnable} onDisable={onDisable} onDuplicate={onDuplicate} onDelete={onDelete} />
        </div>
      )}
    </div>
  );
}

interface SectionProps extends Pick<Props, 'onEdit' | 'onEnable' | 'onDisable' | 'onDuplicate' | 'onDelete'> {
  title: string;
  scope: 'workspace' | 'global';
  resources: Array<LocatedAgentResource<AgentDefinitionDtoV1>>;
  activeCount: (resource: LocatedAgentResource<AgentDefinitionDtoV1>) => number;
}

function LibrarySection({ title, scope, resources, activeCount, onEdit, onEnable, onDisable, onDuplicate, onDelete }: SectionProps) {
  return (
    <section aria-label={title}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}><h2 style={{ ...eyebrowStyle, margin: 0, color: 'var(--term-fg)' }}>{title}</h2><span style={{ color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 10 }}>{resources.length}</span></div>
      {resources.length === 0 ? <div style={emptyStyle}>No {scope} Agents yet.</div> : <div style={{ borderTop: '1px solid var(--term-line)' }}>{resources.map((resource) => <AgentRow key={`${resource.backendConnectionId}:${resource.value.id}`} resource={resource} activeRuns={activeCount(resource)} onEdit={onEdit} onEnable={onEnable} onDisable={onDisable} onDuplicate={onDuplicate} onDelete={onDelete} />)}</div>}
    </section>
  );
}

function AgentRow({ resource, activeRuns, onEdit, onEnable, onDisable, onDuplicate, onDelete }: { resource: LocatedAgentResource<AgentDefinitionDtoV1>; activeRuns: number } & Pick<Props, 'onEdit' | 'onEnable' | 'onDisable' | 'onDuplicate' | 'onDelete'>) {
  const definition = resource.value;
  const identity = { backendConnectionId: resource.backendConnectionId, id: definition.id };
  const profile = [definition.runtimeProfile.runtimeId, definition.runtimeProfile.providerId, definition.runtimeProfile.modelId].filter(Boolean).join(' / ');
  return (
    <article style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1.4fr) minmax(160px, .8fr) 100px 90px minmax(250px, auto)', alignItems: 'center', gap: 14, padding: '14px 0', borderBottom: '1px solid var(--term-line)' }}>
      <button type="button" onClick={() => onEdit(resource)} aria-label={`Edit ${definition.name} ${definition.scope} Agent`} style={{ border: 0, padding: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer', minWidth: 0 }}><span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', fontSize: 14, fontWeight: 600 }}><ScopeBadge scope={definition.scope} />{definition.name}</span><span style={{ display: 'block', marginTop: 4, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{definition.description}</span></button>
      <span style={{ color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 10 }}>{profile || 'runtime not configured'}</span>
      <StatusBadge status={definition.status} />
      <span style={{ color: activeRuns > 0 ? 'var(--term-select, var(--accent))' : 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 10 }}>{activeRuns} active</span>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 5 }}>
        {definition.status === AgentDefinitionStatus.Enabled ? <RowAction label="Disable" name={definition.name} onClick={() => onDisable(identity)} /> : <RowAction label="Enable" name={definition.name} onClick={() => onEnable(identity)} />}
        <RowAction label="Duplicate" name={definition.name} onClick={() => onDuplicate(identity)} />
        <RowAction label="Delete" name={definition.name} danger onClick={() => onDelete(identity)} />
      </div>
    </article>
  );
}

function RowAction({ label, name, danger, onClick }: { label: string; name: string; danger?: boolean; onClick: () => void }) { return <button type="button" aria-label={`${label} ${name}`} onClick={onClick} style={{ ...buttonStyle, padding: '4px 7px', color: danger ? 'var(--danger, var(--term-error))' : 'var(--term-fg)' }}>{label.toLowerCase()}</button>; }
function ScopeBadge({ scope }: { scope: 'global' | 'workspace' }) { return <span style={{ border: '1px solid var(--term-line)', padding: '1px 5px', color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase' }}>{scope}</span>; }
function StatusBadge({ status }: { status: AgentDefinitionStatus }) { const color = status === AgentDefinitionStatus.Enabled ? 'var(--term-success, var(--accent))' : status === AgentDefinitionStatus.Disabled ? 'var(--term-muted)' : 'var(--term-select, var(--accent))'; return <span style={{ color, fontFamily: 'var(--mono-font)', fontSize: 10 }}>{status}</span>; }
const eyebrowStyle: React.CSSProperties = { color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase' };
const buttonStyle: React.CSSProperties = { border: '1px solid var(--term-line)', background: 'transparent', color: 'var(--term-fg)', padding: '6px 9px', fontFamily: 'var(--ui-font)', fontSize: 10, cursor: 'pointer' };
const emptyStyle: React.CSSProperties = { border: '1px dashed var(--term-line)', padding: 18, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 11 };
