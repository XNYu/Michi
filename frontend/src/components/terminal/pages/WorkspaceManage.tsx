import React from 'react';
import { toast } from 'sonner';
import type { PageId } from '../../../state/commands';
import { useChatStore, useChatNodesSnapshot } from '../../../state/chatStore';
import { getElectron } from '../../../lib/electronBridge';
import { importWorkspaceFileUpload, type UploadProgress } from '../../../services/api';
import { sanitizeContextName } from '../../../lib/sanitizeContextName';
import { navigateToNode } from '../../../state/navigateToNode';
import { findTreeIdForNode } from '../../../state/tree';
import UploadProgressBar, { type UploadProgressViewState } from '../../UploadProgressBar';
import { deriveDigests, deriveHeaderCounts } from '../manage/derive';
import ManageHeader from '../manage/ManageHeader';
import ManageComposer from '../manage/ManageComposer';
import ManageTabs from '../manage/ManageTabs';
import ChatTreeList from '../manage/ChatTreeList';
import ContextList from '../manage/ContextList';
import DigestList from '../manage/DigestList';
import ManageSidebar from '../manage/ManageSidebar';

interface Props {
  workspaceId: string | null;
  onNav: (p: PageId) => void;
}

type Tab = 'chats' | 'artifacts' | 'digests';

export default function WorkspaceManage({ workspaceId, onNav }: Props) {
  const store = useChatStore();
  const { activeProjectId, selectProject } = store;
  const nodes = useChatNodesSnapshot();
  const project = workspaceId
    ? store.projects.find((p) => p.id === workspaceId && !p.deletedAt) ?? null
    : null;

  const [tab, setTab] = React.useState<Tab>('chats');
  const [filter, setFilter] = React.useState('');
  const [selectedContextId, setSelectedContextId] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState<UploadProgressViewState | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const dragDepthRef = React.useRef(0);
  const [dropzoneVisible, setDropzoneVisible] = React.useState(false);
  const [droppedFileCount, setDroppedFileCount] = React.useState(0);
  const [manageMode, setManageMode] = React.useState(false);
  const managedProjectId = project?.id ?? null;

  // ManageComposer creates a thread through the active-workspace action. The
  // manager can be opened from the all-workspaces page without activating its
  // project first, so align the active workspace on entry before the user can
  // submit into the wrong project.
  React.useEffect(() => {
    if (managedProjectId && activeProjectId !== managedProjectId) {
      selectProject(managedProjectId);
    }
  }, [activeProjectId, managedProjectId, selectProject]);

  const handleAddContext = React.useCallback(async () => {
    if (importing || !project) return;
    const electron = getElectron();
    if (electron?.chooseFiles) {
      setImporting(true);
      try {
        const r = await electron.chooseFiles();
        if (!r.canceled && r.paths) {
          const existing = (project.artifacts ?? []).map((c) => c.name);
          for (const p of r.paths) {
            const base = p.split('/').pop() ?? p;
            const name = sanitizeContextName(base, existing);
            existing.push(name);
            store.createContext(name, p, { kind: 'reference' });
          }
        }
      } catch (err) {
        toast.error(`Add source failed: ${(err as Error).message}`);
      } finally {
        setImporting(false);
      }
      return;
    }
    fileInputRef.current?.click();
  }, [importing, project, store]);

  const progressForFile = React.useCallback(
    (fileName: string, fileIndex: number, fileCount: number) =>
      (progress: UploadProgress) => {
        setUploadProgress({
          fileName,
          fileIndex,
          fileCount,
          phase: progress.phase,
          percent: progress.percent,
        });
      },
    [],
  );

  const handleImportFiles = React.useCallback(async (files: File[]) => {
    if (files.length === 0 || !project) return;
    const electron = getElectron();
    setImporting(true);
    try {
      const existing = (project.artifacts ?? []).map((c) => c.name);
      for (const [fileIndex, file] of files.entries()) {
        const electronPath = electron?.getPathForFile?.(file) ?? null;
        if (electronPath) {
          const base = electronPath.split('/').pop() ?? electronPath;
          const name = sanitizeContextName(base, existing);
          existing.push(name);
          store.createContext(name, electronPath, { kind: 'reference' });
          continue;
        }
        const cwd = project.cwd;
        if (!cwd) {
          toast.error('Workspace has no folder set');
          return;
        }
        const result = await importWorkspaceFileUpload(project.id, cwd, file, {
          onProgress: progressForFile(file.name, fileIndex, files.length),
        });
        store.createContext(result.name, result.filePath, { size: result.size });
      }
    } catch (err) {
      toast.error(`Add source failed: ${(err as Error).message}`);
    } finally {
      setImporting(false);
      setUploadProgress(null);
    }
  }, [progressForFile, project, store]);

  const handleWebFiles = React.useCallback(async (files: FileList | null) => {
    try {
      await handleImportFiles(files ? Array.from(files) : []);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [handleImportFiles]);

  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  const handleDragEnter = React.useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) {
      setDropzoneVisible(true);
      setDroppedFileCount(e.dataTransfer.items.length);
    }
  }, []);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropzoneVisible(false);
  }, []);

  const handleDrop = React.useCallback(async (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepthRef.current = 0;
    setDropzoneVisible(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    // Auto-switch to artifacts tab so the user sees the new entries.
    setTab('artifacts');
    await handleImportFiles(files);
  }, [handleImportFiles]);

  if (!project) {
    return (
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          fontFamily: 'var(--ui-font)',
          fontSize: 13,
          color: 'var(--term-muted)',
          background: 'var(--term-page-bg, var(--term-bg))',
        }}
      >
        <span>{workspaceId ? 'workspace not found' : 'select a workspace'}</span>
        <button
          type="button"
          onClick={() => onNav('workspaces')}
          style={{
            border: '1px solid var(--term-line)',
            background: 'transparent',
            color: 'var(--term-fg)',
            padding: '4px 10px',
            fontFamily: 'inherit',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          ← back to workspaces
        </button>
      </div>
    );
  }

  const counts = deriveHeaderCounts(project, nodes);
  const digests = deriveDigests(project, nodes);
  const tabCounts = {
    chats: counts.chats,
    artifacts: counts.artifacts,
    digests: digests.length,
  };

  const handleOpenNode = (nodeId: string) => {
    const node = nodes[nodeId];
    if (node?.kind === 'digest') {
      // Digest nodes deliberately sit outside the branch tree. Anchor their
      // dashboard pane to the source thread so opening one from the workspace
      // manager never writes it into whichever thread happened to be active.
      const sourceId = node.digest?.sources.find((id) => project.chatIds.includes(id));
      const treeId = sourceId ? findTreeIdForNode(sourceId, project) : project.activeTreeId;
      if (treeId) {
        if (store.activeProjectId !== project.id) store.selectProject(project.id);
        store.openPaneInTree(project.id, treeId, nodeId);
        store.activateTree(treeId, project.id);
        store.setFocusedNodeId(nodeId);
      } else {
        store.openPane(nodeId);
      }
    } else {
      navigateToNode(
        {
          projects: store.projects,
          activeProjectId: store.activeProjectId,
          selectProject: store.selectProject,
          openPane: store.openPane,
          openPaneInTree: store.openPaneInTree,
          activateTree: store.activateTree,
          setFocusedNodeId: store.setFocusedNodeId,
        },
        nodeId,
        project.id,
      );
    }
    onNav('dashboard');
  };

  const handleSubmitted = () => onNav('dashboard');

  return (
    <div
      style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1fr 360px',
        minHeight: 0,
        background: 'var(--term-page-bg, var(--term-bg))',
      }}
    >
      <main
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => { void handleDrop(e); }}
        style={{
          padding: '20px 56px 60px',
          overflowY: 'auto',
          minWidth: 0,
          position: 'relative',
        }}
      >
        <ManageHeader
          name={project.name}
          cwd={project.cwd}
          chatsCount={counts.chats}
          contextsCount={counts.artifacts}
          branchesCount={counts.branches}
          lastActiveAt={counts.lastActiveAt}
        />
        <ManageComposer
          workspaceId={project.id}
          workspaceName={project.name}
          onSubmitted={handleSubmitted}
        />
        <ManageTabs
          activeTab={tab}
          onChange={(t) => { setTab(t); setFilter(''); }}
          counts={tabCounts}
          filter={filter}
          onFilterChange={setFilter}
        />
        {tab === 'chats' && (
          <ChatTreeList
            workspace={project}
            nodes={nodes}
            filter={filter}
            manageMode={manageMode}
            onOpen={handleOpenNode}
            menuActions={{
              activateTree: store.activateTree,
              archiveTree: store.archiveTree,
              unarchiveTree: store.unarchiveTree,
              pinTree: store.pinTree,
              unpinTree: store.unpinTree,
              renameTree: store.renameTree,
              deleteTree: store.deleteTree,
              exportTree: (treeId) =>
                window.dispatchEvent(
                  new CustomEvent('michi:toggle-export-panel', {
                    detail: { projectId: project.id, treeId },
                  }),
                ),
            }}
            bulkActions={{
              treeSelection: store.treeSelection,
              toggleTreeSelection: store.toggleTreeSelection,
              clearTreeSelection: store.clearTreeSelection,
              selectAllTrees: store.selectAllTrees,
              bulkArchiveTrees: store.bulkArchiveTrees,
              bulkDeleteTrees: store.bulkDeleteTrees,
              bulkUnarchiveTrees: store.bulkUnarchiveTrees,
            }}
          />
        )}
        {tab === 'artifacts' && (
          <>
            <UploadProgressBar progress={uploadProgress} compact />
            <ContextList
              artifacts={project.artifacts ?? []}
              filter={filter}
              selectedContextId={selectedContextId}
              onSelect={setSelectedContextId}
              onAdd={handleAddContext}
              onPin={(id) => store.pinContext?.(id)}
              onDelete={(id) => store.deleteContext?.(id)}
              onPreview={(filePath) => {
                const electron = getElectron();
                if (electron?.openPath) {
                  void electron.openPath(filePath).then((r) => {
                    if (!r.ok && r.error) {
                      console.warn(`openPath(${filePath}) failed:`, r.error);
                      toast.error(`Could not open ${filePath}: ${r.error}`);
                    }
                  });
                  return;
                }
                // Web mode: no shell access. Copy the path so the user can paste
                // it into their own editor / file manager.
                const canCopy = !!navigator.clipboard?.writeText;
                const msg = `Preview requires the desktop app. Path${canCopy ? ' copied' : ''}: ${filePath}`;
                if (canCopy) {
                  void navigator.clipboard
                    .writeText(filePath)
                    .then(() => toast.info(msg))
                    .catch(() => toast.warning(msg));
                } else {
                  toast.warning(msg);
                }
              }}
            />
          </>
        )}
        {tab === 'digests' && (
          <DigestList
            digests={digests}
            filter={filter}
            onOpen={handleOpenNode}
            onRebuild={(id) => { void store.refreshDigest(id); }}
            onExport={(id) =>
              window.dispatchEvent(
                new CustomEvent('michi:toggle-export-panel', {
                  detail: { projectId: project.id, digestNodeId: id },
                }),
              )
            }
          />
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(e) => handleWebFiles(e.target.files)}
          style={{ display: 'none' }}
        />
        {dropzoneVisible && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              border: '2px dashed var(--term-accent)',
              background: 'rgba(47, 143, 115, .15)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'none',
              zIndex: 100,
            }}
          >
            <div
              style={{
                background: 'var(--term-bg)',
                border: '1px solid var(--term-accent)',
                color: 'var(--term-accent)',
                padding: '8px 18px',
                fontFamily: 'var(--ui-font)',
                fontSize: 12,
                borderRadius: 3,
              }}
            >
              drop {droppedFileCount} file{droppedFileCount === 1 ? '' : 's'} · add as context
            </div>
          </div>
        )}
      </main>
      <ManageSidebar
        workspace={project}
        onSaveInstructions={(text) => store.setProjectInstructions(project.id, text)}
        manageMode={manageMode}
        onToggleManageMode={() => {
          if (manageMode) {
            store.clearTreeSelection();
          }
          setManageMode((v) => !v);
        }}
        bulkActions={{
          treeSelection: store.treeSelection,
          toggleTreeSelection: store.toggleTreeSelection,
          clearTreeSelection: store.clearTreeSelection,
          selectAllTrees: store.selectAllTrees,
          bulkArchiveTrees: store.bulkArchiveTrees,
          bulkDeleteTrees: store.bulkDeleteTrees,
          bulkUnarchiveTrees: store.bulkUnarchiveTrees,
        }}
        hasArchivedSelection={
          Array.from(store.treeSelection).some((id) =>
            project.trees.some((t) => t.id === id && !!t.archivedAt),
          )
        }
      />
    </div>
  );
}
