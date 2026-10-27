import type { CodexHostText } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import * as codexText from './hostText/codex';

/**
 * Michi's wording for the Codex adapter (CodexAdapterOptions.hostText): the
 * turn-metadata rules, their Stop-hook POC variant and the title thread's
 * instructions. Each member reads hostText/codex.ts through its module object
 * at every call, so test stubs of those exports still apply.
 */
export function michiCodexHostText(): CodexHostText {
  return {
    turnMetadataInstruction: (...args) => codexText.buildCodexTurnMetadataInstruction(...args),
    followUpsHookPocInstruction: (...args) => codexText.buildCodexFollowUpsHookPocInstruction(...args),
    titleInstructions: () => codexText.TITLE_INSTRUCTIONS,
  };
}
