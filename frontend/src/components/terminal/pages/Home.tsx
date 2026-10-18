import React, { useCallback, useMemo, useState } from 'react';
import { useChatStore, useStructuralSelector } from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import { navigateToNode } from '../../../state/navigateToNode';
import ManageComposer from '../manage/ManageComposer';
import { HomeWorkspaceChip } from '../HomeWorkspaceChip';
import { Dot } from '../primitives';
import { BranchIcon, FolderIcon } from '../icons';
import { buildContinueItems, continueItemsEqual, type ContinueItem } from './homeContinue';

interface HomeProps {
  onSubmitted: () => void;
}

const MAX_RECENTS = 6;
/** The composer is the page's one action, so it runs clearly wider than the
 *  list under it and the two read as primary and secondary rather than as one
 *  block. The list stays narrow enough that a row's title, its workspace and
 *  its timestamp all sit inside the width the eye already has. On narrow
 *  windows both columns shrink to the available width and converge. */
const HOME_COMPOSER_WIDTH = 920;
const HOME_LIST_WIDTH = 680;

export default function TerminalHome({ onSubmitted }: HomeProps) {
  const {
    activeProject,
    activeProjectId,
    projects,
    focusedNodeId,
    selectProject,
    activateTree,
    openPane,
    openPaneInTree,
    setFocusedNodeId,
  } = useChatStore();

  const liveProjects = useMemo(
    () => projects.filter((p) => !p.deletedAt && !p.archivedAt),
    [projects],
  );

  const continueSelector = useCallback(
    (nodesMap: Record<string, ChatNodeState>) =>
      buildContinueItems(liveProjects, nodesMap, focusedNodeId, MAX_RECENTS),
    [liveProjects, focusedNodeId],
  );
  const recents = useStructuralSelector(continueSelector, continueItemsEqual);

  const openThread = (item: ContinueItem) => {
    const alreadyActive =
      item.projectId === activeProjectId
      && projects.find((p) => p.id === item.projectId)?.activeTreeId === item.id;
    // A row can live in any workspace — go through navigateToNode so the
    // destination pane is seeded before the workspace/thread switch.
    navigateToNode(
      { projects, activeProjectId, selectProject, openPane, openPaneInTree, activateTree, setFocusedNodeId },
      item.rootNodeId,
      item.projectId,
    );
    // navigateToNode only activates a tree when it has to switch to it. Opening
    // a thread from Home has always marked the whole thread read (the row's
    // unread dot covers its branches too), so do that for the thread that is
    // already active as well.
    if (alreadyActive) activateTree(item.id, item.projectId);
    onSubmitted();
  };

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
          maxWidth: HOME_COMPOSER_WIDTH,
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-5xl)',
            fontWeight: 500,
            color: 'var(--term-fg)',
            textAlign: 'center',
            margin: 0,
            letterSpacing: 'var(--ls-tight)',
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
            // Open with room for a second line so a longer prompt doesn't start
            // out cramped; it still grows to the shared max-height cap.
            ['--composer-min-rows' as string]: '2',
            ['--composer-chrome-size' as string]: 'var(--fs-lg)',
            // Hero chips: bigger font, but tighter horizontal padding and
            // letter-spacing so the row stays compact rather than sprawling.
            // Icon-only chips track --composer-chip-height for square sizing.
            ['--composer-chip-size' as string]: 'var(--fs-lg)',
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
            maxWidth: HOME_LIST_WIDTH,
            marginTop: 44,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              fontSize: 'var(--fs-sm)',
              letterSpacing: 'var(--ls-caps-wide)',
              color: 'var(--term-muted)',
              textTransform: 'uppercase',
              paddingBottom: 8,
              paddingLeft: 4,
              borderBottom: '1px solid var(--term-line)',
            }}
          >
            continue
          </div>
          {recents.map((r) => (
            <ContinueRow key={`${r.projectId}:${r.id}`} item={r} onClick={() => openThread(r)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One thread to pick back up: what it is, what it's doing, where it lives,
 *  how far it has branched and when it last moved — all on one line. */
function ContinueRow({ item, onClick }: { item: ContinueItem; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      data-testid="home-continue-row"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        // status dot · title · workspace · branches · age
        gridTemplateColumns: '8px minmax(0, 1fr) minmax(0, 150px) 34px 30px',
        alignItems: 'center',
        columnGap: 10,
        width: '100%',
        height: 38,
        padding: '0 4px',
        border: 0,
        borderBottom: '1px solid var(--term-line)',
        textAlign: 'left',
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-xl)',
        color: 'var(--term-fg)',
        background: hover ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
        cursor: 'pointer',
        transition: 'background var(--t-quick) var(--t-ease)',
      }}
    >
      <span
        {...(item.status === 'idle'
          ? { 'aria-hidden': true }
          : { role: 'img', 'aria-label': item.status })}
        style={{ display: 'inline-flex', justifyContent: 'center' }}
      >
        {item.status === 'streaming' && <Dot color="var(--term-select)" size={6} pulse />}
        {item.status === 'unread' && <Dot color="var(--term-accent)" size={6} />}
      </span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          color: 'var(--term-mid)',
          fontSize: 'var(--fs-md)',
        }}
      >
        <FolderIcon size={12} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.projectName}
        </span>
      </span>
      <span
        {...(item.branches > 0
          ? { role: 'img', 'aria-label': `${item.branches} branch${item.branches === 1 ? '' : 'es'}` }
          : { 'aria-hidden': true })}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 3,
          color: 'var(--term-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        {item.branches > 0 && (
          <>
            <BranchIcon size={11} />
            {item.branches}
          </>
        )}
      </span>
      <span
        style={{
          textAlign: 'right',
          color: 'var(--term-muted)',
          fontFamily: 'var(--font-mono)',
          fontSize: 'var(--fs-sm)',
        }}
      >
        {formatRelative(item.lastActiveAt)}
      </span>
    </button>
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
