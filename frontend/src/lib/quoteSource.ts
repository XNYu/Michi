import type { FileReadSnapshot } from '../state/fileFeedbackTypes';

/**
 * Optional source metadata for the selection. When the selection comes from
 * an artifact file (rather than a chat message), the context prefix and
 * follow-up instruction change so the agent knows which document it came from.
 */
export interface QuoteSource {
  type: 'artifact';
  /** Display name of the artifact (e.g. "API Spec"). */
  name?: string;
  /** File path relative to the workspace cwd. */
  filePath: string;
  /**
   * W3C Web Annotation-aligned text selector for precise anchoring.
   * Optional — only populated when the selection can be mapped to
   * character offsets in the source document.
   */
  selector?: import('./textSelector').TextSelector;
  snapshot?: FileReadSnapshot;
}

/**
 * Context the user attached rather than selected from a reply: the ⌘J
 * assistant's page line and the Michi items handed to it (any selection the
 * user also quoted rides in the same block).
 */
export interface AttachedQuoteSource {
  type: 'attached';
}

/** Every source a quote's framing can name: an artifact, or attached context. */
export type AnyQuoteSource = QuoteSource | AttachedQuoteSource;
