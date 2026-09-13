import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '../../../state/chatStore';
import type { MentionEditorHandle } from '../../MentionEditor';
const MentionEditor = React.lazy(() => import('../../MentionEditor'));
import type { MentionRecord } from '../../mentions';
import { expandMentions } from '../../mentions';
import { getElectron } from '../../../lib/electronBridge';
import {
  getWebUploadCwd,
  importWorkspaceFileUpload,
  copyWorkspaceFile,
  saveAgentOptions,
  bindPendingPrimaryAgent,
  fetchAgentStatus,
  listPrimaryAgentDefinitions,
  type PrimaryAgentDefinitionOption,
  type AgentReasoning,
  type UploadProgress,
} from '../../../services/api';
import { useAgentModelCatalog } from '../../../hooks/useAgentModelCatalog';
import { resolveNodeBinding } from '../../../state/nodeBindingResolution';
import { appendAttachmentsSentinel } from '../../../lib/composerAttachments';
import { toast } from 'sonner';
import { ComposerShell } from '../ComposerShell';
import { PaneComposerToolbarLeft, type PaneMenuAnchor } from '../PaneComposerToolbarLeft';
import { ComposerModelTrigger } from '../ComposerModelTrigger';
import { resolveComposerReasoning } from '../composerReasoning';
import { PaneAgentMenus } from '../PaneAgentMenus';
import { PaneComposerActions } from '../PaneComposerActions';
import { activeBackendApiBase, backendConnectionIdForWorkspace, workspaceBackendApiBase } from '../../../config/backendConnections';
import UploadProgressBar, { type UploadProgressViewState } from '../../UploadProgressBar';

type ComposerDraft = { value: string; mentions: MentionRecord[] };

interface PendingAttachment {
  id: string;
  name: string;
  absPath: string;
  /** Workspace-relative path (e.g. ".attachments/img.png"). Present for uploaded files. */
  relPath?: string;
}

// In-memory draft survives unmount within a session, but successful sends
// reset it. Cleared on full reload.
const composerDrafts = new Map<string, ComposerDraft>();
// Last pre-picked agent, sticky across unmounts within a session (mirrors how
// composer drafts persist). Lets the Home composer remember the chosen agent after
// you send and come back. A stale id (e.g. after a runtime switch) is dropped at
// render time once the mode list is known.
let manageStickyModeId: string | undefined;
const manageStickyPrimaryAgent = new Map<string, PrimaryAgentDefinitionOption>();

export function __resetManageComposerSessionStateForTests() {
  composerDrafts.clear();
  manageStickyModeId = undefined;
  manageStickyPrimaryAgent.clear();
}

interface Props {
  /** Create a follow-up from this digest instead of a new root thread. */
  parentNodeId?: string;
  /** Fixed workspace target. Omit on Home where the user picks via the chip. */
  workspaceId?: string;
  /** Display name for fixed-workspace mode. Falls back to active project name. */
  workspaceName?: string;
  /** Extra toolbar content rendered before the standard left toolbar (e.g. workspace picker chip). */
  toolbarLeftPrefix?: React.ReactNode;
  /**
   * Show the agent (⎇) chip so the user can pre-pick an agent before the
   * thread exists. The pick is applied to the new thread's session on send.
   * Off by default — entry points that create a conversation on submit
   * (Home or digest follow-ups) can enable it.
   */
  enableAgentSelect?: boolean;
  onSubmitted: () => void;
}

/** Build a thumbnail src for a pending image attachment in ManageComposer. */
function pendingThumbSrc(p: PendingAttachment, workspaceId?: string): string | null {
  if (workspaceId && p.relPath) {
    const encoded = p.relPath.split('/').map(encodeURIComponent).join('/');
    return `${workspaceBackendApiBase(workspaceId)}/files/${encodeURIComponent(workspaceId)}/${encoded}`;
  }
  if (workspaceId && p.absPath) {
    const marker = '/.attachments/';
    const idx = p.absPath.indexOf(marker);
    if (idx !== -1) {
      const rel = '.attachments/' + p.absPath.slice(idx + marker.length);
      const encoded = rel.split('/').map(encodeURIComponent).join('/');
      return `${workspaceBackendApiBase(workspaceId)}/files/${encodeURIComponent(workspaceId)}/${encoded}`;
    }
  }
  return null;
}

export default function ManageComposer(props: Props) {
  const scope = props.parentNodeId ? `${props.workspaceId ?? ''}:${props.parentNodeId}` : '__manage__';
  return <ScopedManageComposer key={scope} {...props} />;
}

function ScopedManageComposer({
  parentNodeId,
  workspaceId: fixedWorkspaceId,
  toolbarLeftPrefix,
  enableAgentSelect = false,
  onSubmitted,
}: Props) {
  const {
    activeProject,
    selectProject,
    createThread,
    createChildChat,
    sendMessage,
    agentStatus,
    refreshAgentStatus,
    availableModes,
    projects,
  } = useChatStore();

  const workspaceId = fixedWorkspaceId ?? activeProject?.id ?? '';
  const project = projects.find((p) => p.id === workspaceId);
  const usesActiveBackend = workspaceBackendApiBase(workspaceId) === activeBackendApiBase();
  const customAgentsEnabled = agentStatus?.customAgentsEnabled === true;

  const draftKey = parentNodeId ? `${workspaceId}:${parentNodeId}` : '__manage__';
  const [draft, setDraftState] = useState<ComposerDraft>(
    () => composerDrafts.get(draftKey) ?? { value: '', mentions: [] },
  );
  const draftRef = useRef<ComposerDraft>(draft);
  const setDraft = useCallback(
    (nextOrUpdater: ComposerDraft | ((prev: ComposerDraft) => ComposerDraft)) => {
      const next = typeof nextOrUpdater === 'function'
        ? (nextOrUpdater as (prev: ComposerDraft) => ComposerDraft)(draftRef.current)
        : nextOrUpdater;
      draftRef.current = next;
      composerDrafts.set(draftKey, next);
      setDraftState(next);
    },
    [draftKey],
  );
  const inputRef = useRef<MentionEditorHandle>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

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
  const [primaryAgents, setPrimaryAgents] = useState<PrimaryAgentDefinitionOption[]>([]);
  const [primaryAgentsLoading, setPrimaryAgentsLoading] = useState(false);
  const [primaryAgentsError, setPrimaryAgentsError] = useState<string | null>(null);
  const [pendingPrimaryAgent, setPendingPrimaryAgentState] = useState<PrimaryAgentDefinitionOption | undefined>(
    () => workspaceId ? manageStickyPrimaryAgent.get(workspaceId) : undefined,
  );
  const setPendingPrimaryAgent = useCallback((agent: PrimaryAgentDefinitionOption | undefined) => {
    if (workspaceId) {
      if (agent) manageStickyPrimaryAgent.set(workspaceId, agent);
      else manageStickyPrimaryAgent.delete(workspaceId);
    }
    setPendingPrimaryAgentState(agent);
  }, [workspaceId]);

  useEffect(() => {
    setPendingPrimaryAgentState(workspaceId ? manageStickyPrimaryAgent.get(workspaceId) : undefined);
    if (!enableAgentSelect || !workspaceId || (usesActiveBackend && !customAgentsEnabled)) {
      setPrimaryAgents([]);
      setPrimaryAgentsLoading(false);
      setPrimaryAgentsError(null);
      return;
    }
    const controller = new AbortController();
    setPrimaryAgentsLoading(true);
    setPrimaryAgentsError(null);
    const load = async () => {
      if (!usesActiveBackend) {
        const status = await fetchAgentStatus(backendConnectionIdForWorkspace(workspaceId), controller.signal);
        if (!status.customAgentsEnabled) return [];
      }
      return listPrimaryAgentDefinitions(workspaceId, controller.signal);
    };
    void load()
      .then((definitions) => {
        if (controller.signal.aborted) return;
        setPrimaryAgents(definitions);
        const sticky = manageStickyPrimaryAgent.get(workspaceId);
        if (sticky && !definitions.some((candidate) => candidate.definition.id === sticky.definition.id && candidate.backendConnectionId === sticky.backendConnectionId)) {
          manageStickyPrimaryAgent.delete(workspaceId);
          setPendingPrimaryAgentState(undefined);
        }
      })
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') setPrimaryAgentsError((error as Error).message);
      })
      .finally(() => { if (!controller.signal.aborted) setPrimaryAgentsLoading(false); });
    return () => controller.abort();
  }, [enableAgentSelect, workspaceId, usesActiveBackend, customAgentsEnabled]);
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

  // ManageComposer creates new threads — use global agentStatus as the binding
  // (no node exists yet). resolveNodeBinding(null, agentStatus) returns source: 'global'.
  const manageResolvedBinding = resolveNodeBinding(null, agentStatus);
  const composerEffort = resolveComposerReasoning(manageResolvedBinding, agentStatus, null, providerModels, agentStatus?.providers);

  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressViewState | null>(null);
  const [dragHover, setDragHover] = useState(false);
  const dragDepthRef = useRef(0);
  const webFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => () => {
    webFileInputRef.current?.remove();
    webFileInputRef.current = null;
  }, [workspaceId]);

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

  const addPendingPaths = useCallback((items: ReadonlyArray<string | { abs: string; displayName?: string; relPath?: string }>) => {
    if (items.length === 0) return;
    setPendingAttachments((prev) => {
      const have = new Set(prev.map((p) => p.absPath));
      const next = [...prev];
      for (const item of items) {
        const abs = typeof item === 'string' ? item : item.abs;
        const override = typeof item === 'string' ? undefined : item.displayName;
        const relPath = typeof item === 'string' ? undefined : item.relPath;
        if (have.has(abs)) continue;
        const name = override || abs.split('/').pop() || abs;
        next.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name,
          absPath: abs,
          relPath,
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
    if (electron?.chooseFiles && !project?.backendConnectionId) {
      const res = await electron.chooseFiles();
      if (res.canceled || !res.paths?.length) return;
      const cwd = await resolveAttachCwd();
      if (!cwd || !project?.id) {
        toast.error('No workspace folder for file attachment');
        return;
      }
      const items: Array<{ abs: string; displayName: string; relPath: string }> = [];
      const errors: string[] = [];
      for (const sourcePath of res.paths) {
        try {
          const result = await copyWorkspaceFile(project.id, cwd, sourcePath, {
            subdir: '.attachments',
          });
          const abs = result.filePath.startsWith('/')
            ? result.filePath
            : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
          items.push({
            abs,
            displayName: result.displayName || sourcePath.split('/').pop() || sourcePath,
            relPath: result.filePath,
          });
        } catch (err) {
          const name = sourcePath.split('/').pop() || sourcePath;
          errors.push(`${name}: ${(err as Error).message}`);
        }
      }
      if (items.length > 0) addPendingPaths(items);
      if (errors.length > 0) {
        toast.error(
          `${errors.length} file${errors.length === 1 ? '' : 's'} failed`,
          { description: errors.join('\n'), style: { whiteSpace: 'pre-line' } },
        );
      }
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
        const items: Array<{ abs: string; displayName: string; relPath?: string }> = [];
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
            items.push({ abs, displayName: result.displayName || file.name, relPath: result.filePath });
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
  }, [project?.id, project?.backendConnectionId, addPendingPaths, progressForFile, resolveAttachCwd]);

  const insertMentionTrigger = useCallback(() => {
    inputRef.current?.editor?.chain().focus().insertContent('@').run();
  }, []);

  const openModelMenu = useCallback(
    (anchor: PaneMenuAnchor) => {
      setAgentMenu(null);
      setModelMenu((current) => current ? null : anchor);
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

      const pendingItems: Array<string | { abs: string; displayName?: string; relPath?: string }> = [];
      const errors: string[] = [];
      for (const [fileIndex, file] of items.entries()) {
        try {
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
          pendingItems.push({ abs, displayName: result.displayName || fileName, relPath: result.filePath });
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
    [project?.id, project?.backendConnectionId, addPendingPaths, progressForFile, resolveAttachCwd],
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

      const absPaths: Array<string | { abs: string; relPath?: string }> = [];
      const errors: string[] = [];
      for (const [fileIndex, file] of files.entries()) {
        try {
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
          absPaths.push({ abs, relPath: result.filePath });
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
    [addPendingPaths, progressForFile, project?.id, project?.backendConnectionId, resolveAttachCwd],
  );

  const submit = async () => {
    if (submittingRef.current || uploadProgress) return;
    const submitDraft = draftRef.current;
    const raw = expandMentions(submitDraft.value, submitDraft.mentions).trim();
    if (!raw && pendingAttachments.length === 0) return;
    if (!workspaceId) return;

    selectProject(workspaceId);
    const attachmentsForSend = pendingAttachments.map((p) => ({
      name: p.name,
      absPath: p.absPath,
      relPath: p.relPath,
    }));
    // Attachments stay scoped to the thread we're about to create (the agent
    // reads them via the [Attached files: …] sentinel). We intentionally do
    // NOT promote them to workspace artifacts: that registered each upload as a
    // workspace-level context row which the first-turn manifest then advertised
    // to every other conversation, so sibling threads kept reading unrelated
    // screenshots.

    const finalText = appendAttachmentsSentinel(raw, attachmentsForSend);
    const mentionsForMeta = submitDraft.mentions.length > 0
      ? submitDraft.mentions.map(m => ({ kind: m.kind, refId: m.refId, label: m.label }))
      : undefined;
    // A digest follow-up has a parent session. Make the visible selection
    // explicit so that session's runtime/model cannot override the chips.
    const bindingMeta = parentNodeId && !pendingPrimaryAgent && agentStatus ? {
      runtimeId: manageResolvedBinding.runtime,
      providerId: manageResolvedBinding.provider,
      modelId: manageResolvedBinding.model,
      reasoning: composerEffort.value ?? null,
    } : undefined;
    const meta =
      attachmentsForSend.length > 0 || mentionsForMeta || bindingMeta
        ? {
            ...bindingMeta,
            ...(attachmentsForSend.length > 0 ? { attachments: attachmentsForSend.map((a) => ({ ...a })) } : {}),
            displayText: raw,
            mentions: mentionsForMeta,
          }
        : undefined;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const modeId = pendingPrimaryAgent ? undefined : currentModeId;
      const primaryAgent = pendingPrimaryAgent ? {
        backendConnectionId: pendingPrimaryAgent.backendConnectionId,
        definitionId: pendingPrimaryAgent.definition.id,
      } : undefined;
      if (parentNodeId) {
        await createChildChat(parentNodeId, finalText, meta, { modeId, primaryAgent });
      } else {
        let nodeId: string | null;
        try {
          nodeId = await createThread(modeId);
        } catch {
          // The store already surfaced the allocation failure.
          return;
        }
        if (!nodeId) return;
        if (primaryAgent) {
          bindPendingPrimaryAgent(nodeId, { workspaceId, ...primaryAgent });
        }
        sendMessage(nodeId, finalText, meta);
      }
      setDraft({ value: '', mentions: [] });
      setPendingAttachments([]);
      onSubmitted();
    } catch (error) {
      toast.error(parentNodeId ? 'Could not start digest follow-up' : 'Could not start thread', {
        description: (error as Error).message,
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
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
  const selectedAgentLabel = pendingPrimaryAgent?.definition.name;

  const canAttach = !!getElectron()?.chooseFiles || !!project;
  const sendDisabled =
    (!draft.value.trim() && pendingAttachments.length === 0) || !workspaceId || submitting || !!uploadProgress;

  // Same-tree mentions don't apply on the manage page (no active thread).
  // Pass the project's artifacts so @<contextName> still works.
  const artifacts = useMemo(() => project?.artifacts ?? [], [project?.artifacts]);

  return (
    <div style={{ marginBottom: parentNodeId ? 0 : 18, flexShrink: 0, minWidth: 0 }}>
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
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 8px' }}>
                {pendingAttachments.map((p) => {
                  const ext = p.name.split('.').pop()?.toLowerCase() ?? '';
                  const isImage = ['png','jpg','jpeg','gif','webp'].includes(ext);
                  const thumbSrc = isImage ? pendingThumbSrc(p, workspaceId) : null;

                  if (isImage && thumbSrc) {
                    return (
                      <span key={p.id} title={p.name} className="t-att-pending-item" style={{ display: 'inline-block' }}>
                        <img
                          src={thumbSrc}
                          alt={p.name}
                          style={{ width: 64, height: 64, objectFit: 'cover', display: 'block' }}
                        />
                        <span
                          className="t-att-pending-x"
                          onClick={() => removePendingAttachment(p.id)}
                        >
                          ×
                        </span>
                      </span>
                    );
                  }

                  return (
                    <span key={p.id} className="t-att-pending-item t-att-pending-file" title={p.absPath}>
                      <span style={{ fontSize: 10, opacity: 0.7 }}>📄</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
                        {p.name}
                      </span>
                      <span
                        className="t-att-pending-x"
                        onClick={() => removePendingAttachment(p.id)}
                      >
                        ×
                      </span>
                    </span>
                  );
                })}
              </div>
            ) : null}
          </>
        }
        input={
          <React.Suspense fallback={<div className="composer-loading-stub" />}>
          <MentionEditor
            ref={inputRef}
            value={draft.value}
            mentions={draft.mentions}
            onChange={setDraft}
            disabled={submitting}
            className="hide-sb"
            artifacts={artifacts}
            sameTreeNodes={[]}
            currentNodeId={parentNodeId ?? '__manage__'}
            enableSlash={false}
            onSubmit={() => submit()}
            onPaste={(e) => { void handlePaste(e as unknown as React.ClipboardEvent<HTMLTextAreaElement>); }}
          />
          </React.Suspense>
        }
        toolbarLeft={<div style={{ display: 'flex', flex: '0 1 auto', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {toolbarLeftPrefix}
          <PaneComposerToolbarLeft
            canAttach={canAttach}
            toolbarTier={0}
            enableAgentChip={enableAgentSelect}
            currentMode={selectedAgentLabel ? { id: pendingPrimaryAgent!.definition.id, name: selectedAgentLabel } : currentMode}
            currentModeId={selectedAgentLabel ? pendingPrimaryAgent!.definition.id : currentModeId}
            availableModesCount={enableAgentSelect ? availableModes.length + primaryAgents.length + 1 : 0}
            agentStatus={agentStatus}
            onPickFile={() => void onPickFile()}
            onInsertMentionTrigger={insertMentionTrigger}
            onOpenAgentMenu={setAgentMenu}
          />
        </div>}
        toolbarRight={
          <>
          <ComposerModelTrigger
            toolbarTier={0}
            agentStatus={agentStatus}
            resolvedBinding={manageResolvedBinding}
            catalogCapabilities={null}
            providerModels={providerModels}
            providers={agentStatus?.providers}
            isStreaming={submitting}
            modelMenuOpen={!!modelMenu}
            onOpenModelMenu={openModelMenu}
          />
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
          </>
        }
      />

      <PaneAgentMenus
        agentMenu={agentMenu}
        modelMenu={modelMenu}
        disabled={submitting}
        availableModes={availableModes}
        currentModeId={currentModeId}
        agentStatus={agentStatus}
        resolvedBinding={manageResolvedBinding}
        catalogCapabilities={null}
        providerModels={providerModels}
        providers={agentStatus?.providers}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        onSwitchAgent={(modeId) => {
          // No thread yet — record the pick locally. submit() stamps it onto
          // the new thread, which applies it to the session on send. When
          // enableAgentSelect is off the chip is hidden, so this never fires.
          setPendingModeId(modeId);
          setPendingPrimaryAgent(undefined);
          setAgentMenu(null);
        }}
        primaryAgents={primaryAgents.map(({ definition }) => ({
          id: definition.id,
          name: definition.name,
          scope: definition.scope,
          runtimeSummary: [definition.runtimeProfile.runtimeId, definition.runtimeProfile.providerId, definition.runtimeProfile.modelId].filter(Boolean).join(' · '),
        }))}
        selectedPrimaryAgentId={pendingPrimaryAgent?.definition.id}
        primaryAgentsLoading={primaryAgentsLoading}
        primaryAgentsError={primaryAgentsError}
        onSelectPrimaryAgent={(id) => {
          const selected = primaryAgents.find((agent) => agent.definition.id === id);
          if (!selected) return;
          setPendingPrimaryAgent(selected);
          setPendingModeId(undefined);
          setAgentMenu(null);
        }}
        onSelectDefaultAgent={() => {
          setPendingPrimaryAgent(undefined);
          setPendingModeId(undefined);
          setAgentMenu(null);
        }}
        onSwitchRuntime={async (runtimeId) => {
          const result = await saveAgentOptions({ runtime: runtimeId });
          if (!result.ok) throw new Error(result.error);
          refreshAgentStatus();
        }}
        onSaveProvider={async (provider) => {
          const result = await saveAgentOptions({ provider });
          if (!result.ok) throw new Error(result.error);
          refreshAgentStatus();
        }}
        onSaveModel={async (model) => {
          const result = await saveAgentOptions({ model });
          if (!result.ok) throw new Error(result.error);
          refreshAgentStatus();
        }}
        onSaveReasoning={async (reasoning) => {
          const result = await saveAgentOptions({ reasoning: reasoning as AgentReasoning });
          if (!result.ok) throw new Error(result.error);
          refreshAgentStatus();
        }}
        onRetryModels={retryModels}
        onCloseAgentMenu={() => setAgentMenu(null)}
        onCloseModelMenu={() => setModelMenu(null)}
      />
    </div>
  );
}
