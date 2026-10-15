import type { AgentCommand } from './chatStreamEvents';
import type { RuntimeReasoning } from './agentRuns';
import { isReasoningLevel, sanitizeReasoningLevels, type ModelReasoningCapabilities } from './reasoning';

/** Replaceable session state, independent of transcript/turn sequence numbers. */
export interface AgentSessionState {
  runtimeId: string;
  nativeEngine?: string;
  version?: number;
  currentModeId?: string | null;
  modelId?: string | null;
  reasoning?: RuntimeReasoning | null;
  availableModes?: Array<{ id: string; name: string; description?: string }>;
  availableModels?: Array<ModelReasoningCapabilities & { id: string; label?: string; description?: string }>;
  commands?: AgentCommand[];
  mcpErrors?: Array<{ serverName: string; error: string }>;
}

export function parseSessionState(data: Record<string, unknown>): AgentSessionState {
  const state: AgentSessionState = { runtimeId: typeof data.runtimeId === 'string' ? data.runtimeId : '' };
  if (typeof data.version === 'number' && Number.isFinite(data.version)) state.version = data.version;
  if (typeof data.nativeEngine === 'string') state.nativeEngine = data.nativeEngine;
  for (const key of ['currentModeId', 'modelId'] as const) {
    if (typeof data[key] === 'string' || data[key] === null) state[key] = data[key];
  }
  if (data.reasoning === null || isReasoningLevel(data.reasoning)) state.reasoning = data.reasoning;
  if (Array.isArray(data.availableModes)) state.availableModes = data.availableModes.flatMap((mode) =>
    mode && typeof mode.id === 'string' ? [{ id: mode.id, name: typeof mode.name === 'string' ? mode.name : mode.id,
      ...(typeof mode.description === 'string' ? { description: mode.description } : {}),
    }] : []);
  if (Array.isArray(data.availableModels)) state.availableModels = data.availableModels.flatMap((model) =>
    model && typeof model.id === 'string' ? [{ id: model.id,
      ...(typeof model.label === 'string' ? { label: model.label } : {}),
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      ...(typeof model.supportsReasoning === 'boolean' ? { supportsReasoning: model.supportsReasoning } : {}),
      ...(Array.isArray(model.supportedReasoningLevels) ? { supportedReasoningLevels: sanitizeReasoningLevels(model.supportedReasoningLevels) } : {}),
      ...(isReasoningLevel(model.defaultReasoning) ? { defaultReasoning: model.defaultReasoning } : {}),
    }] : []);
  if (Array.isArray(data.commands)) state.commands = data.commands.flatMap((command) =>
    command && typeof command.name === 'string' ? [{ name: command.name,
      ...(typeof command.description === 'string' ? { description: command.description } : {}),
      ...(typeof command.input?.type === 'string' ? { input: { type: command.input.type } } : {}),
    }] : []);
  if (Array.isArray(data.mcpErrors)) state.mcpErrors = data.mcpErrors.flatMap((error) =>
    error && typeof error.serverName === 'string' && typeof error.error === 'string'
      ? [{ serverName: error.serverName, error: error.error }] : []);
  return state;
}
