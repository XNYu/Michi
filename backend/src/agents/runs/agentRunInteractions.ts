import { AgentRunEventType, AgentRunStatus, AgentRunWaitingReason, type AgentInteractionKind, type JsonValue } from 'michi-shared';
import type { AgentRunRepositoryPort } from './ports';
import { AgentRunEventBus } from './agentRunEventBus';

function waitingReason(kind: AgentInteractionKind): AgentRunWaitingReason {
  switch (kind) {
    case 'permission': return AgentRunWaitingReason.Permission;
    case 'context': return AgentRunWaitingReason.Context;
    case 'user_input': return AgentRunWaitingReason.UserInput;
    case 'parent_input': return AgentRunWaitingReason.ParentInput;
  }
}

export class AgentRunInteractions {
  constructor(private readonly repository: AgentRunRepositoryPort, private readonly events: AgentRunEventBus) {}

  request(ownerUserId: string, runId: string, attemptId: string | null,
    kind: AgentInteractionKind, request: JsonValue, operationId: string) {
    const interaction = this.repository.createInteraction(ownerUserId, runId, attemptId, kind, request, operationId);
    const run = this.repository.getRun(ownerUserId, runId);
    if (!run) throw new Error('run not found');
    const event = this.repository.appendEventAndProject(ownerUserId, runId, run.latestEventSeq, {
      type: AgentRunEventType.InteractionRequested,
      attemptId,
      payload: { version: 1, interactionId: interaction.id, kind },
    }, { status: AgentRunStatus.Waiting, waitingReason: waitingReason(kind) });
    this.events.publishCommitted(event);
    return interaction;
  }

  resolve(ownerUserId: string, interactionId: string, response: JsonValue, operationId: string) {
    const interaction = this.repository.resolveInteraction(ownerUserId, interactionId, 'resolved', response, operationId);
    if (!interaction) return null;
    const run = this.repository.getRun(ownerUserId, interaction.runId);
    if (!run) throw new Error('run not found');
    const event = this.repository.appendEventAndProject(ownerUserId, run.id, run.latestEventSeq, {
      type: AgentRunEventType.InteractionResolved,
      attemptId: interaction.attemptId,
      payload: { version: 1, interactionId, status: 'resolved' },
    }, { status: AgentRunStatus.Running, waitingReason: null });
    this.events.publishCommitted(event);
    return interaction;
  }
}
