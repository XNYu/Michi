/** Incremental reading of newly completed, user-initiated turns in one workspace. */
export interface ReadConversationUpdatesInput {
  after: number;
  through?: number;
  limit?: number;
  includeMessages?: boolean;
}

export interface ConversationUpdateMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationUpdate {
  completionSeq: number;
  turnId: string;
  nodeId: string;
  treeId: string | null;
  userMessageId: string;
  assistantMessageId: string;
  completedAt: number;
  preview: string;
  messages?: ConversationUpdateMessage[];
  /** This entry was identified but NOT delivered/consumed. nextAfter never crosses it. */
  contentTooLarge?: true;
  contentUnavailable?: true;
}

export interface ConversationUpdates {
  after: number;
  through: number;
  totalTurns: number;
  byNode: Array<{ nodeId: string; treeId: string | null; newTurnCount: number }>;
  turns: ConversationUpdate[];
  nextAfter: number;
  hasMore: boolean;
}

export const CONVERSATION_UPDATES_LIMITS = { defaultLimit: 20, maxLimit: 100, messageBytes: 64 * 1024 } as const;

export class ConversationUpdatesError extends Error {
  constructor(readonly code: 'invalid_argument' | 'cursor_invalid' | 'not_found' | 'navigation_disabled', message: string) {
    super(message);
  }
}

export function parseReadConversationUpdatesInput(value: unknown): Required<Omit<ReadConversationUpdatesInput, 'through'>> & { through?: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConversationUpdatesError('invalid_argument', 'Expected an object');
  }
  const input = value as Record<string, unknown>;
  const integer = (key: string, fallback?: number): number => {
    const v = input[key] === undefined ? fallback : input[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
      throw new ConversationUpdatesError('invalid_argument', `${key} must be a nonnegative safe integer`);
    }
    return v;
  };
  const after = integer('after');
  const through = input.through === undefined ? undefined : integer('through');
  const limit = integer('limit', CONVERSATION_UPDATES_LIMITS.defaultLimit);
  if (limit < 1 || limit > CONVERSATION_UPDATES_LIMITS.maxLimit) {
    throw new ConversationUpdatesError('invalid_argument', 'limit must be between 1 and 100');
  }
  if (input.includeMessages !== undefined && typeof input.includeMessages !== 'boolean') {
    throw new ConversationUpdatesError('invalid_argument', 'includeMessages must be boolean');
  }
  return { after, through, limit, includeMessages: input.includeMessages === true };
}
