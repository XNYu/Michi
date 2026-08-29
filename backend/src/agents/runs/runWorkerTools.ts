import {
  assertSecretFreePublicPayload,
  parseResultBundleV1,
  type ExternalActionReceiptV1,
  type GitChangeSetRefV1,
  type JsonValue,
  type ResourceMutationReceiptV1,
  type ResultArtifactRefV1,
  type ResultBundleV1,
  type RunUsageSummaryV1,
} from 'michi-shared';
import type { RuntimeSessionOwner, RuntimeToolProfile } from '../types';

export const SUBMIT_AGENT_RESULT_TOOL = 'submit_agent_result';

export interface RunWorkerToolProfile extends RuntimeToolProfile {
  /** In-process hook consumed by fake transports and future native tool bridges. */
  runWorkerTools: {
    submitAgentResult(owner: RuntimeSessionOwner, payload: unknown): ResultBundleV1;
  };
}

function sameOwner(left: RuntimeSessionOwner, right: RuntimeSessionOwner): boolean {
  return left.kind === 'agent_run' && right.kind === 'agent_run'
    && left.runId === right.runId && left.attemptId === right.attemptId;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function trimConclusion(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'The worker completed without a final assistant summary.';
  return trimmed.slice(0, 16_000);
}

export class RunResultCollector {
  private submitted: ResultBundleV1 | null = null;
  private submittedCanonical: string | null = null;
  private readonly artifacts: ResultArtifactRefV1[] = [];
  private readonly resourceMutations: ResourceMutationReceiptV1[] = [];
  private readonly externalActions: ExternalActionReceiptV1[] = [];
  private changeSet: GitChangeSetRefV1 | undefined;
  private usage: RunUsageSummaryV1 | undefined;

  constructor(readonly owner: RuntimeSessionOwner) {
    if (owner.kind !== 'agent_run') throw new Error('submit_agent_result is available only to Agent Run sessions');
  }

  createToolProfile(allowedToolNames: readonly string[], capabilitySnapshot?: JsonValue): RunWorkerToolProfile {
    return {
      allowedToolNames: [...new Set([...allowedToolNames, SUBMIT_AGENT_RESULT_TOOL])],
      capabilitySnapshot,
      runWorkerTools: { submitAgentResult: (owner, payload) => this.submit(owner, payload) },
    };
  }

  submit(owner: RuntimeSessionOwner, payload: unknown): ResultBundleV1 {
    if (!sameOwner(this.owner, owner)) throw new Error('submit_agent_result owner does not match the active Run Attempt');
    assertSecretFreePublicPayload(payload, 'submit_agent_result');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('submit_agent_result payload must be a Result Bundle object');
    }
    const bundle = parseResultBundleV1({ ...(payload as Record<string, unknown>), source: 'submitted' }, 'submit_agent_result');
    const serialized = canonical(bundle);
    if (this.submittedCanonical !== null) {
      if (serialized !== this.submittedCanonical) throw new Error('submit_agent_result already received a different Result Bundle');
      return this.submitted!;
    }
    this.submitted = bundle;
    this.submittedCanonical = serialized;
    return bundle;
  }

  recordArtifact(artifact: ResultArtifactRefV1): void { this.artifacts.push({ ...artifact }); }
  recordResourceMutation(receipt: ResourceMutationReceiptV1): void { this.resourceMutations.push({ ...receipt }); }
  recordExternalAction(receipt: ExternalActionReceiptV1): void { this.externalActions.push({ ...receipt }); }
  recordChangeSet(changeSet: GitChangeSetRefV1 | null): void { this.changeSet = changeSet ? { ...changeSet, changedFiles: [...changeSet.changedFiles] } : undefined; }
  recordUsage(usage: RunUsageSummaryV1): void { this.usage = { ...usage }; }

  finalize(finalAssistantText: string): ResultBundleV1 {
    if (this.submitted) return this.submitted;
    const artifactsOrChanges = [
      this.artifacts.length ? `${this.artifacts.length} artifact(s)` : '',
      this.resourceMutations.length ? `${this.resourceMutations.length} resource mutation(s)` : '',
      this.externalActions.length ? `${this.externalActions.length} external action(s)` : '',
      this.changeSet?.summary ?? '',
    ].filter(Boolean).join('; ');
    return parseResultBundleV1({
      version: 1,
      status: 'completed',
      source: 'inferred',
      handoff: {
        conclusion: trimConclusion(finalAssistantText),
        artifactsOrChanges,
        unresolvedIssues: '',
      },
      artifacts: this.artifacts,
      resourceMutations: this.resourceMutations,
      externalActions: this.externalActions,
      ...(this.changeSet ? { changeSet: this.changeSet } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
    });
  }
}

export function createRunResultCollector(owner: RuntimeSessionOwner): RunResultCollector {
  return new RunResultCollector(owner);
}

export function discoverRunWorkerTools(owner: RuntimeSessionOwner): readonly string[] {
  return owner.kind === 'agent_run' ? [SUBMIT_AGENT_RESULT_TOOL] : [];
}
