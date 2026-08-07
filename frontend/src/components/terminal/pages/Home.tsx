import React, { useMemo, useState } from 'react';
import { useChatStore, useStructuralSelector } from '../../../state/chatStore';
import ManageComposer from '../manage/ManageComposer';
import { HomeWorkspaceChip } from '../HomeWorkspaceChip';

interface HomeProps {
  onSubmitted: () => void;
}

const MAX_RECENTS = 6;

export default function TerminalHome({ onSubmitted }: HomeProps) {
  const {
    activeProject,
    projects,
    selectProject,
    activateTree,
  } = useChatStore();

  const liveProjects = useMemo(
    () => projects.filter((p) => !p.deletedAt && !p.archivedAt),
    [projects],
  );

  const recents = useStructuralSelector((nodesMap) => {
    if (!activeProject) return [];
    const trees = activeProject.trees
      .filter((t) => !t.archivedAt && !nodesMap[t.rootNodeId]?.deletedAt)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      .slice(0, MAX_RECENTS);
    return trees.map((t) => ({
      id: t.id,
      label: t.name || nodesMap[t.rootNodeId]?.title || 'Untitled',
      lastActiveAt: t.lastActiveAt,
    }));
  });

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // Anchor the hero cluster (title + composer) at a stable Y instead of
        // vertically centering the whole column. Centering meant recents
        // count changed the cluster's height and shifted the composer up/down
        // between workspaces — recents now flow downward as a sibling block
        // and never push the composer.
        paddingTop: 'max(120px, 22vh)',
        paddingBottom: 40,
        paddingLeft: 24,
        paddingRight: 24,
        fontFamily: 'var(--ui-font)',
        color: 'var(--term-fg)',
        background: 'var(--term-page-bg, var(--term-bg))',
        minHeight: 0,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 740,
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 28,
            fontWeight: 500,
            color: 'var(--term-fg)',
            textAlign: 'center',
            margin: 0,
            letterSpacing: '-.005em',
            lineHeight: 1.3,
          }}
        >
          <span style={{ color: 'var(--term-accent)' }}>_ </span>
          Another road diverged in a yellow wood.
        </h1>

        {/* Override the shared composer typography vars only on Home, so the
            input feels like a hero element without bloating chat bubbles or
            the workspace-page composer. MentionEditor reads both vars at
            render time, so cascading from this wrapper is enough — no prop
            plumbing into ManageComposer required. */}
        <div
          style={{
            ['--message-body-size' as string]: '17px',
            ['--message-body-leading' as string]: '1.55',
            ['--composer-chrome-size' as string]: '13px',
            // Hero chips: bigger font, but tighter horizontal padding and
            // letter-spacing so the row stays compact rather than sprawling.
            // Icon-only chips track --composer-chip-height for square sizing.
            ['--composer-chip-size' as string]: '13px',
            ['--composer-chip-height' as string]: '30px',
            ['--composer-chip-h-pad' as string]: '8px',
            ['--composer-chip-gap' as string]: '5px',
            ['--composer-chip-tracking' as string]: '0',
          } as React.CSSProperties}
        >
          <ManageComposer
            onSubmitted={onSubmitted}
            enableAgentSelect
            toolbarLeftPrefix={
              <HomeWorkspaceChip
                active={activeProject ?? null}
                liveProjects={liveProjects}
                onSelect={selectProject}
                onNewWorkspace={() =>
                  window.dispatchEvent(new CustomEvent('michi:open-new-workspace'))
                }
              />
            }
          />
        </div>
      </div>

      {recents.length > 0 && (
        <div
          style={{
            width: '100%',
            maxWidth: 740,
            marginTop: 44,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: '.14em',
              color: 'var(--term-faint)',
              textTransform: 'uppercase',
              marginBottom: 10,
              paddingLeft: 4,
            }}
          >
            recent threads
          </div>
          {recents.map((r) => (
            <RecentRow
              key={r.id}
              label={r.label}
              rel={formatRelative(r.lastActiveAt)}
              onClick={() => {
                activateTree(r.id);
                onSubmitted();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RecentRow({
  label,
  rel,
  onClick,
}: {
  label: string;
  rel: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 10px',
        fontFamily: 'var(--ui-font)',
        fontSize: 14,
        color: hover ? 'var(--term-fg)' : 'var(--term-mid)',
        background: hover ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
        cursor: 'pointer',
        transition: 'background var(--t-quick) var(--t-ease)',
      }}
    >
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--term-faint)', fontSize: 12 }}>{rel}</span>
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}
