import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../../../state/chatStore';
import MentionEditor, { type MentionEditorHandle } from '../../MentionEditor';
import type { MentionRecord } from '../../mentions';
import { expandMentions } from '../../mentions';
import { getElectron } from '../../../lib/electronBridge';
import {
  getWebUploadCwd,
  importWorkspaceFileUpload,
  saveAgentOptions,
  type AgentReasoning,
  type UploadProgress,
} from '../../../services/api';
import { useAgentModelCatalog } from '../../../hooks/useAgentModelCatalog';
import { appendAttachmentsSentinel } from '../../../lib/composerAttachments';
import { toast } from 'sonner';
import { ComposerShell } from '../ComposerShell';
import { PaneComposerToolbarLeft, type PaneMenuAnchor } from '../PaneComposerToolbarLeft';
import { PaneAgentMenus } from '../PaneAgentMenus';
import { PaneComposerActions } from '../PaneComposerActions';
import UploadProgressBar, { type UploadProgressViewState } from '../../UploadProgressBar';

type ComposerDraft = { value: string; mentions: MentionRecord[] };

interface PendingAttachment {
  id: string;
  name: string;
  absPath: string;
}

// In-memory draft survives unmount within a session, but successful sends
// reset it. Cleared on full reload.
let manageDraft: ComposerDraft = { value: '', mentions: [] };
// Last pre-picked agent, sticky across unmounts within a session (mirrors how
// manageDraft persists). Lets the Home composer remember the chosen agent after
// you send and come back. A stale id (e.g. after a runtime switch) is dropped at
// render time once the mode list is known.
let manageStickyModeId: string | undefined;

export function __resetManageComposerSessionStateForTests() {
  manageDraft = { value: '', mentions: [] };
  manageStickyModeId = undefined;
}

interface Props {
  /** Fixed workspace target. Omit on Home where the user picks via the chip. */
  workspaceId?: string;
  /** Display name for fixed-workspace mode. Falls back to active project name. */
  workspaceName?: string;
  /** Extra toolbar content rendered before the standard left toolbar (e.g. workspace picker chip). */
  toolbarLeftPrefix?: React.ReactNode;
  /**
   * Show the agent (⎇) chip so the user can pre-pick an agent before the
   * thread exists. The pick is applied to the new thread's session on send.
   * Off by default — only entry points that create a thread on submit
   * (e.g. Home) should enable it.
   */
  enableAgentSelect?: boolean;
  onSubmitted: () => void;
}

export default function ManageComposer({
  workspaceId: fixedWorkspaceId,
  toolbarLeftPrefix,
  enableAgentSelect = false,
  onSubmitted,
}: Props) {
  const {
    activeProject,
    selectProject,
    createThread,
    sendMessage,
    agentStatus,
    refreshAgentStatus,
    availableModes,
    projects,
  } = useChatStore();

  const workspaceId = fixedWorkspaceId ?? activeProject?.id ?? '';
  const project = projects.find((p) => p.id === workspaceId);

  const [draft, setDraftState] = useState<ComposerDraft>(() => manageDraft);
  const draftRef = useRef<ComposerDraft>(draft);
  const setDraft = useCallback(
    (nextOrUpdater: ComposerDraft | ((prev: ComposerDraft) => ComposerDraft)) => {
      const next = typeof nextOrUpdater === 'function'
        ? (nextOrUpdater as (prev: ComposerDraft) => ComposerDraft)(draftRef.current)
        : nextOrUpdater;
      draftRef.current = next;
      manageDraft = next;
      setDraftState(next);
    },
    [],
  );
  const inputRef = useRef<MentionEditorHandle>(null);

  const [agentMenu, setAgentMenu] = useState<PaneMenuAnchor | null>(null);
  const [modelMenu, setModelMenu] = useState<PaneMenuAnchor | null>(null);
  // Pre-session agent pick. Only meaningful when enableAgentSelect is on; the
  // chosen mode is stamped onto the new thread in submit() and applied to its
  // session at ensure-session time so the first message runs under it. Seeded
  // from (and written back to) the module-level sticky so the pick survives
  // unmount within a session.
  const [pendingModeId, setPendingModeIdState] = useState<string | undefined>(
    () => manageStickyModeId,
  );
  const setPendingModeId = useCallback((id: string | undefined) => {
    manageStickyModeId = id;
    setPendingModeIdState(id);
  }, []);
  const shouldLoadModels = !!modelMenu && !!(
    agentStatus?.capabilities.providerModels || agentStatus?.capabilities.models === true
  );
  const {
    models: providerModels,
    loading: modelsLoading,
    error: modelsError,
    retry: retryModels,
  } = useAgentModelCatalog({
    enabled: shouldLoadModels,
    runtime: agentStatus?.runtime,
    provider: agentStatus?.provider,
  });

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressViewState | null>(null);
  const [dragHover, setDragHover] = useState(false);
  const dragDepthRef = useRef(0);
  const webFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) {
      const tag = active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const resolveAttachCwd = useCallback(async (): Promise<string | null> => {
    if (project?.cwd) return project.cwd;
    if (!project?.id) return null;
    return getWebUploadCwd(project.id);
  }, [project?.cwd, project?.id]);

  const addPendingPaths = useCallback((items: ReadonlyArray<string | { abs: string; displayName?: string }>) => {
    if (items.length === 0) return;
    setPendingAttachments((prev) => {
      const have = new Set(prev.map((p) => p.absPath));
      const next = [...prev];
      for (const item of items) {
        const abs = typeof item === 'string' ? item : item.abs;
        const override = typeof item === 'string' ? undefined : item.displayName;
        if (have.has(abs)) continue;
        const name = override || abs.split('/').pop() || abs;
        next.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name,
          absPath: abs,
        });
        have.add(abs);
      }
      return next;
    });
  }, []);

  const removePendingAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const progressForFile = useCallback(
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

  const onPickFile = useCallback(async () => {
    const electron = getElectron();
    if (electron?.chooseFiles) {
      const res = await electron.chooseFiles();
      if (res.canceled || !res.paths) return;
      addPendingPaths(res.paths);
      return;
    }
    if (!webFileInputRef.current) {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const files = Array.from(input.files ?? []);
        input.value = '';
        if (files.length === 0) return;
        const items: Array<{ abs: string; displayName: string }> = [];
        const errors: string[] = [];
        for (const [fileIndex, file] of files.entries()) {
          try {
            const cwd = await resolveAttachCwd();
            if (!cwd || !project?.id) {
              errors.push(`${file.name}: no workspace folder`);
              continue;
            }
            const result = await importWorkspaceFileUpload(project.id, cwd, file, {
              onProgress: progressForFile(file.name, fileIndex, files.length),
              subdir: '.attachments',
            });
            const abs = result.filePath.startsWith('/')
              ? result.filePath
              : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
            items.push({ abs, displayName: result.displayName || file.name });
          } catch (err) {
            errors.push(`${file.name}: ${(err as Error).message}`);
          }
        }
        setUploadProgress(null);
        if (items.length > 0) addPendingPaths(items);
        if (errors.length > 0) {
          toast.error(
            `${errors.length} file${errors.length === 1 ? '' : 's'} failed`,
            { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
          );
        }
      });
      document.body.appendChild(input);
      webFileInputRef.current = input;
    }
    webFileInputRef.current.click();
  }, [project?.id, addPendingPaths, progressForFile, resolveAttachCwd]);

  const insertMentionTrigger = useCallback(() => {
    inputRef.current?.editor?.chain().focus().insertContent('@').run();
  }, []);

  const openModelMenu = useCallback(
    (anchor: PaneMenuAnchor, _shouldLoadModels: boolean) => {
      setModelMenu(anchor);
    },
    [],
  );

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const items: File[] = [];
      for (const item of Array.from(dt.items)) {
        if (item.kind !== 'file') continue;
        const f = item.getAsFile();
        if (f) items.push(f);
      }
      if (items.length === 0) return;
      e.preventDefault();

      const electron = getElectron();
      const pendingItems: Array<string | { abs: string; displayName: string }> = [];
      const errors: string[] = [];
      for (const [fileIndex, file] of items.entries()) {
        const path = electron?.getPathForFile?.(file) ?? null;
        try {
          if (path) {
            pendingItems.push(path);
            continue;
          }
          const cwd = await resolveAttachCwd();
          if (!cwd || !project?.id) {
            errors.push(`${file.name || 'pasted file'}: no workspace folder`);
            continue;
          }
          const nameExtMatch = file.name && file.name.match(/\.[a-zA-Z0-9]{1,8}$/);
          const ext = nameExtMatch
            ? nameExtMatch[0]
            : (file.type && file.type.startsWith('image/')
                ? `.${file.type.slice('image/'.length).split(';')[0] || 'png'}`
                : '');
          const stem = (file.name && file.name.replace(/\.[a-zA-Z0-9]{1,8}$/, '')) || 'pasted';
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const fileName = `${stem}-${ts}${ext}`;
          const result = await importWorkspaceFileUpload(project.id, cwd, file, {
            originalName: fileName,
            onProgress: progressForFile(fileName, fileIndex, items.length),
            subdir: '.attachments',
          });
          const abs = result.filePath.startsWith('/')
            ? result.filePath
            : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
          pendingItems.push({ abs, displayName: result.displayName || fileName });
        } catch (err) {
          errors.push(`${file.name || 'pasted file'}: ${(err as Error).message}`);
        }
      }
      setUploadProgress(null);
      if (pendingItems.length > 0) addPendingPaths(pendingItems);
      if (errors.length > 0) {
        toast.error(
          `${errors.length} paste${errors.length === 1 ? '' : 's'} failed`,
          { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
        );
      }
    },
    [project?.id, addPendingPaths, progressForFile, resolveAttachCwd],
  );

  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files');

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) setDragHover(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragHover(false);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepthRef.current = 0;
      setDragHover(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      const electron = getElectron();
      const absPaths: string[] = [];
      const errors: string[] = [];
      for (const [fileIndex, file] of files.entries()) {
        const path = electron?.getPathForFile?.(file) ?? null;
        try {
          if (path) {
            absPaths.push(path);
            continue;
          }
          const cwd = await resolveAttachCwd();
          if (!cwd) {
            errors.push(`${file.name}: no workspace folder`);
            continue;
          }
          if (!project?.id) {
            errors.push(`${file.name}: no workspace selected`);
            continue;
          }
          const result = await importWorkspaceFileUpload(project.id, cwd, file, {
            onProgress: progressForFile(file.name, fileIndex, files.length),
            subdir: '.attachments',
          });
          const abs = result.filePath.startsWith('/')
            ? result.filePath
            : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
          absPaths.push(abs);
        } catch (err) {
          errors.push(`${file.name}: ${(err as Error).message}`);
        }
      }
      setUploadProgress(null);
      if (absPaths.length > 0) addPendingPaths(absPaths);
      if (errors.length > 0) {
        toast.error(
          `${errors.length} file${errors.length === 1 ? '' : 's'} failed`,
          { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
        );
      }
    },
    [addPendingPaths, progressForFile, project?.id, resolveAttachCwd],
  );

  const submit = async () => {
    const raw = expandMentions(draft.value, draft.mentions).trim();
    if (!raw && pendingAttachments.length === 0) return;
    if (!workspaceId) return;

    selectProject(workspaceId);
    const attachmentsForSend = pendingAttachments.map((p) => ({
      name: p.name,
      absPath: p.absPath,
    }));
    // Attachments stay scoped to the thread we're about to create (the agent
    // reads them via the [Attached files: …] sentinel). We intentionally do
    // NOT promote them to workspace artifacts: that registered each upload as a
    // workspace-level context row which the first-turn manifest then advertised
    // to every other conversation, so sibling threads kept reading unrelated
    // screenshots.

    let nodeId: string | null;
    try {
      nodeId = await createThread(currentModeId);
    } catch {
      // The store already surfaced the allocation failure.
      return;
    }
    if (!nodeId) return;
    const finalText = appendAttachmentsSentinel(raw, attachmentsForSend);
    const mentionsForMeta = draft.mentions.length > 0
      ? draft.mentions.map(m => ({ kind: m.kind, refId: m.refId, label: m.label }))
      : undefined;
    const meta =
      attachmentsForSend.length > 0 || mentionsForMeta
        ? {
            ...(attachmentsForSend.length > 0 ? { attachments: attachmentsForSend.map((a) => ({ ...a })) } : {}),
            displayText: raw,
            mentions: mentionsForMeta,
          }
        : undefined;
    sendMessage(nodeId, finalText, meta);
    setDraft({ value: '', mentions: [] });
    setPendingAttachments([]);
    onSubmitted();
  };

  // No active thread here. When agent pre-selection is enabled, the chip
  // reflects the user's pending pick (applied to the new thread on send);
  // otherwise it stays unset so the chip reads "agent" rather than asserting
  // a selection that has no target. A sticky pick that no longer exists in the
  // loaded mode list is dropped so the chip never shows a dangling raw id.
  const selectedModeId = enableAgentSelect ? pendingModeId : undefined;
  const currentModeId =
    selectedModeId && availableModes.length > 0 && !availableModes.some((m) => m.id === selectedModeId)
      ? undefined
      : selectedModeId;
  const currentMode = currentModeId
    ? availableModes.find((m) => m.id === currentModeId)
    : undefined;

  const canAttach = !!getElectron()?.chooseFiles || !!project;
  const sendDisabled =
    (!draft.value.trim() && pendingAttachments.length === 0) || !workspaceId;

  // Same-tree mentions don't apply on the manage page (no active thread).
  // Pass the project's artifacts so @<contextName> still works.
  const artifacts = useMemo(() => project?.artifacts ?? [], [project?.artifacts]);

  return (
    <div style={{ marginBottom: 18 }}>
      <ComposerShell
        position="static"
        dragHover={dragHover}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => { void handleDrop(e); }}
        preBlocks={
          <>
            <UploadProgressBar progress={uploadProgress} />
            {pendingAttachments.length > 0 ? (
              <div className="t-pre-block tone-muted is-att">
                <div className="t-pre-block-cap">
                  <b>{pendingAttachments.length}</b>{' '}
                  {pendingAttachments.length === 1 ? 'file' : 'files'} · sent with next message
                </div>
                <div className="t-att-chips">
                  {pendingAttachments.map((p) => (
                    <span key={p.id} className="t-att-chip" title={p.absPath}>
                      <span style={{ fontSize: 10, opacity: 0.7 }}>📄</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name}
                      </span>
                      <span
                        className="t-att-chip-x"
                        onClick={() => removePendingAttachment(p.id)}
                      >
                        ×
                      </span>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        }
        input={
          <MentionEditor
            ref={inputRef}
            value={draft.value}
            mentions={draft.mentions}
            onChange={setDraft}
            className="hide-sb"
            artifacts={artifacts}
            sameTreeNodes={[]}
            currentNodeId="__manage__"
            enableSlash={false}
            onSubmit={() => submit()}
            onPaste={(e) => { void handlePaste(e as unknown as React.ClipboardEvent<HTMLTextAreaElement>); }}
          />
        }
        toolbarLeft={<>
          {toolbarLeftPrefix}
          <PaneComposerToolbarLeft
            canAttach={canAttach}
            toolbarTier={0}
            enableAgentChip={enableAgentSelect}
            currentMode={currentMode}
            currentModeId={currentModeId}
            availableModesCount={enableAgentSelect ? availableModes.length : 0}
            agentStatus={agentStatus}
            providerModels={providerModels}
            onPickFile={() => void onPickFile()}
            onInsertMentionTrigger={insertMentionTrigger}
            onOpenAgentMenu={setAgentMenu}
            onOpenModelMenu={openModelMenu}
          />
        </>}
        toolbarRight={
          <PaneComposerActions
            draftHasText={false}
            sendMode="send"
            streaming={false}
            sendDisabled={sendDisabled}
            onBranch={() => { /* manage page has no thread to branch from */ }}
            onSend={submit}
            onStop={() => { /* never reached: streaming=false */ }}
            onRetry={() => { /* never reached: sendMode='send' */ }}
          />
        }
      />

      <PaneAgentMenus
        agentMenu={agentMenu}
        modelMenu={modelMenu}
        availableModes={availableModes}
        currentModeId={currentModeId}
        agentStatus={agentStatus}
        providerModels={providerModels}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        onSwitchAgent={(modeId) => {
          // No thread yet — record the pick locally. submit() stamps it onto
          // the new thread, which applies it to the session on send. When
          // enableAgentSelect is off the chip is hidden, so this never fires.
          setPendingModeId(modeId);
          setAgentMenu(null);
        }}
        onSaveModel={(model) => {
          void saveAgentOptions({ model }).then(() => {
            refreshAgentStatus();
          });
        }}
        onSaveReasoning={(reasoning) => {
          void saveAgentOptions({ reasoning: reasoning as AgentReasoning }).then(() => {
            refreshAgentStatus();
          });
        }}
        onRetryModels={retryModels}
        onCloseAgentMenu={() => setAgentMenu(null)}
        onCloseModelMenu={() => setModelMenu(null)}
      />
    </div>
  );
}
