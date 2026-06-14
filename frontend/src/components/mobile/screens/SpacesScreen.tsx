import React from 'react';
import { useChatStore } from '../../../state/chatStore';

interface Props {
  onPicked: () => void;
}

export default function SpacesScreen({ onPicked }: Props) {
  const { projects, activeProjectId, selectProject } = useChatStore();
  const live = projects.filter((p) => !p.deletedAt && !p.archivedAt);

  const pick = (id: string) => {
    selectProject(id);
    onPicked();
  };

  return (
    <div className="m-screen">
      <div className="m-screen-header">
        <span className="m-screen-title">Spaces</span>
      </div>
      {live.length === 0 ? (
        <div className="m-empty">
          <div className="m-empty-headline">No workspaces</div>
          <div className="m-empty-sub">
            Create one on desktop. Mobile can switch between existing spaces but
            can't make new ones (workspace creation needs a cwd path picker).
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {live.map((p) => {
            const active = p.id === activeProjectId;
            return (
              <div
                key={p.id}
                className="m-thread-row"
                onClick={() => pick(p.id)}
                style={{ alignItems: 'flex-start' }}
              >
                <div
                  className="m-thread-dot"
                  style={{
                    background: active ? 'var(--term-accent)' : 'var(--term-faint)',
                    marginTop: 5,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="m-thread-name">{p.name}</div>
                  <div className="m-thread-meta">
                    {p.cwd ? p.cwd : 'no cwd'} · {p.chatIds.length} node
                    {p.chatIds.length === 1 ? '' : 's'}
                  </div>
                </div>
                {active && (
                  <span style={{ color: 'var(--term-accent)', fontSize: 11 }}>active</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
