/**
 * The runtime binding of an assistant conversation, in the shape of a
 * primary-Agent binding so every session path (ensure-session, session load,
 * ChatManager.ensureParentSession, Kiro context reset) applies it unchanged:
 * the runtime profile pins runtime/model/reasoning, and the session options
 * carry the assistant instructions, its non-worker tool profile and its own
 * empty working directory (every call site spreads them after the client's
 * cwd, so the client cannot point the assistant at a project).
 *
 * Runtime choice: the Meta agent settings, resolved on every binding. A
 * conversation whose bound session ran on another runtime gets a new native
 * session on this one, seeded with its visible history, by the same resume
 * paths that rebuild any session whose runtime changed.
 *
 * A node of an assistant workspace never binds as anything else: the marker
 * is read from the row itself, deleted or purged, and on a cloud backend
 * (which never offers the assistant) the binding is refused outright.
 */

import {
  AgentPolicyCategory,
  AgentPolicyDecision,
  isAssistantWorkspaceSettings,
  type EffectiveAgentDefinitionV1,
  type RuntimeProfileV1,
} from 'michi-shared';
import type { AgentReasoning, NewAgentSessionOptions } from '../agents/types';
import { getModelReasoningOptions } from '../agents/modelReasoning';
import { getRuntime } from '../agents/registry';
import { getDb } from '../services/db';
import { getNode, type WorkspaceRow } from '../services/dbRepository';
import { metaAgentGuardFailureOf, recordMetaAgentGuardCheck } from '../services/metaAgent/guardStatus';
import { ASSISTANT_INSTRUCTIONS, assistantProfileHash, assistantToolProfile } from './policy';
import { assistantConversationRuntime, assistantCwd } from './store';

export interface AssistantSessionBinding {
  effectiveDefinition: EffectiveAgentDefinitionV1;
  profileHash: string;
  /** `cwd` overrides whatever directory the client sent: the assistant never runs in a project. */
  sessionOptions: Pick<NewAgentSessionOptions, 'bootstrapInstructions' | 'toolProfile' | 'profileHash' | 'cwd'>;
}

/** An assistant conversation that may not run here (ChatManager answers it as a PrimaryAgentBindingError). */
export class AssistantBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssistantBindingError';
  }
}

/** The node's workspace row whatever its state: getWorkspace hides purged ones. */
function workspaceRowOf(workspaceId: string): WorkspaceRow | null {
  return (getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as unknown as WorkspaceRow | undefined) ?? null;
}

/**
 * Null unless `nodeId` is a chat in an assistant workspace. Throws
 * AssistantBindingError for one on a cloud backend.
 */
export function resolveAssistantBinding(nodeId: string, override?: { reasoning: RuntimeProfileV1['reasoning'] }): AssistantSessionBinding | null {
  const node = getNode(nodeId);
  if (!node) return null;
  const workspace = workspaceRowOf(node.workspace_id);
  if (!workspace || !isAssistantWorkspaceSettings(workspace.settings)) return null;
  if (process.env.MICHI_CLOUD === '1') {
    throw new AssistantBindingError('The Michi assistant runs only in the desktop app.');
  }

  const runs = assistantConversationRuntime();
  const runtimeProfile: RuntimeProfileV1 = {
    version: 1,
    runtimeId: runs.runtimeId,
    providerId: runs.providerId,
    modelId: runs.modelId,
    reasoning: override ? override.reasoning : runs.reasoning,
  };
  const profileHash = assistantProfileHash(runtimeProfile);
  return {
    effectiveDefinition: assistantDefinition(runtimeProfile),
    profileHash,
    sessionOptions: {
      bootstrapInstructions: ASSISTANT_INSTRUCTIONS,
      toolProfile: assistantToolProfile(),
      profileHash,
      cwd: assistantCwd(),
    },
  };
}

/**
 * resolveAssistantBinding for a session about to start: a reasoning level the
 * resolved model cannot use (Kiro's auto model takes none) is dropped, as it is
 * for ordinary conversations and scheduled runs, instead of failing the session.
 */
export async function resolveAssistantBindingForSession(nodeId: string): Promise<AssistantSessionBinding | null> {
  const binding = resolveAssistantBinding(nodeId);
  if (!binding) return null;
  const profile = binding.effectiveDefinition.runtimeProfile;
  const runtime = getRuntime(profile.runtimeId);
  if (!runtime || !profile.reasoning) return binding;
  const effort = await getModelReasoningOptions(runtime, profile.modelId, profile.providerId, profile.reasoning as AgentReasoning);
  const reasoning = (effort.value ?? null) as RuntimeProfileV1['reasoning'];
  return reasoning === profile.reasoning ? binding : resolveAssistantBinding(nodeId, { reasoning });
}

/**
 * Records the chat toolset's restriction check for an assistant conversation.
 * `error` null: a turn on it succeeded, so its session passed. Otherwise the
 * error its session failed to open with, or its turn ended on; only a
 * restriction failure is recorded. Any other node is ignored.
 */
export function recordAssistantGuardCheck(nodeId: string, error: unknown | null): void {
  if (process.env.MICHI_CLOUD === '1') return;
  const node = getNode(nodeId);
  const workspace = node ? workspaceRowOf(node.workspace_id) : null;
  if (!workspace || !isAssistantWorkspaceSettings(workspace.settings)) return;
  const failure = error === null ? null : metaAgentGuardFailureOf(error);
  if (error !== null && !failure) return;
  const { followsGlobal: _followsGlobal, ...profile } = assistantConversationRuntime();
  recordMetaAgentGuardCheck({ toolset: 'chat', profile, failure });
}

/** A well-formed definition for code that reads a primary binding; never stored. */
function assistantDefinition(runtimeProfile: RuntimeProfileV1): EffectiveAgentDefinitionV1 {
  return {
    version: 1,
    name: 'Michi assistant',
    description: 'Reads and coordinates Michi threads across workspaces and maintains Michi Pages. Not a worker.',
    instructions: ASSISTANT_INSTRUCTIONS,
    runtimeProfile,
    fallbackChain: [],
    capabilitySnapshot: { version: 1, entries: [] },
    permissionPolicy: {
      version: 1,
      preset: 'custom',
      categories: {
        [AgentPolicyCategory.Read]: AgentPolicyDecision.Allow,
        [AgentPolicyCategory.Search]: AgentPolicyDecision.Allow,
        [AgentPolicyCategory.Browse]: AgentPolicyDecision.Deny,
        [AgentPolicyCategory.ArtifactWrite]: AgentPolicyDecision.Deny,
        [AgentPolicyCategory.FilesystemWrite]: AgentPolicyDecision.Deny,
        [AgentPolicyCategory.ShellExec]: AgentPolicyDecision.Deny,
        [AgentPolicyCategory.ExternalAction]: AgentPolicyDecision.Ask,
        [AgentPolicyCategory.SpawnAgent]: AgentPolicyDecision.Deny,
      },
      maxDelegationDepth: 0,
      maxConcurrentRuns: 1,
      maxWallTimeMs: 24 * 60 * 60 * 1_000,
      maxAttempts: 1,
      maxTokens: null,
      maxSpendMicros: null,
    },
    contextPolicy: {
      version: 1,
      includeWorkspaceInstructions: false,
      allowMessageContext: true,
      allowFileContext: false,
      allowArtifactContext: false,
      maxEstimatedChars: 200_000,
    },
  };
}
