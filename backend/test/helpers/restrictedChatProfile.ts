import { ASSISTANT_ALLOWED_TOOL_NAMES } from '../../src/assistant/policy';
import type { RuntimeToolProfile } from '../../src/agents/types';

/** Explicit closed chat profile for the adapters' restriction contract tests. */
export function restrictedChatProfile(): RuntimeToolProfile {
  return { allowedToolNames: ASSISTANT_ALLOWED_TOOL_NAMES, assistant: true, restricted: true, metaAgentToolset: 'chat' };
}
