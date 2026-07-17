import React from 'react';
import { useChatActions, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { confirmDialog } from '../ui/ConfirmDialog';

export default function TreeSelectionBar() {
  const {
    treeSelection,
    activeProject,
  } = useChatProjects();
  const {
    clearTreeSelection,
    selectAllTrees,
    bulkArchiveTrees,
    bulkDeleteTrees,
    createMergedChat,
  } = useChatActions();

  // Map selected tree IDs → root node IDs (createMergedChat takes node IDs).
  const count = treeSelection.size;
  const rootNodeIds = React.useMemo(
    () =>
      Array.from(treeSelection)
        .map((tid) => activeProject?.trees.find((t) => t.id === tid)?.rootNodeId)
        .filter((id): id is string => !!id),
    [activeProject, treeSelection],
  );
  const anyStreaming = useStructuralSelector(
    React.useCallback(
      (nodes) => rootNodeIds.some((id) => nodes[id]?.status === 'streaming'),
      [rootNodeIds],
    ),
  );
  if (count === 0) return null;

  const canMerge = count >= 2 && rootNodeIds.length >= 2;
  const mergeDisabled = !canMerge || anyStreaming;

  const onMerge = () => {
    if (mergeDisabled) return;
    try {
      createMergedChat(rootNodeIds);
      clearTreeSelection();
    } catch {
      // createMergedChat already surfaced a toast on validation failure.
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 10px 5px 14px',
        background: 'var(--term-alt)',
        borderBottom: '1px solid var(--term-line)',
        fontSize: 11,
        fontFamily: 'var(--ui-font)',
      }}
    >
      <span style={{ color: 'var(--term-fg)', fontWeight: 600 }}>{count} selected</span>
      <div style={{ flex: 1 }} />
      <span onClick={selectAllTrees} style={{ cursor: 'pointer', color: 'var(--term-muted)', fontSize: 10 }}>
        Select all
      </span>
      {canMerge && (
        <span
          role="button"
          aria-disabled={mergeDisabled}
          title={anyStreaming ? 'Wait for streaming to finish before merging.' : 'Merge selected threads into a new chat'}
          onClick={onMerge}
          style={{
            cursor: mergeDisabled ? 'not-allowed' : 'pointer',
            color: mergeDisabled ? 'var(--term-muted)' : 'var(--term-fg)',
            fontSize: 10,
            opacity: mergeDisabled ? 0.5 : 1,
          }}
        >
          Merge
        </span>
      )}
      <span onClick={bulkArchiveTrees} style={{ cursor: 'pointer', color: 'var(--term-muted)', fontSize: 10 }}>
        Archive
      </span>
      <span
        onClick={() => {
          void confirmDialog({
            title: 'Move to trash',
            message: `Move ${count} thread${count === 1 ? '' : 's'} to trash?`,
            confirmLabel: 'Move',
          }).then((ok) => { if (ok) bulkDeleteTrees(); });
        }}
        style={{ cursor: 'pointer', color: 'var(--term-danger, #e55)', fontSize: 10 }}
      >
        Delete
      </span>
      <span onClick={clearTreeSelection} style={{ cursor: 'pointer', color: 'var(--term-muted)', fontSize: 10 }}>
        ✕
      </span>
    </div>
  );
}
