export type DomainErrorKind = 'invalid_argument' | 'not_found' | 'conflict';

/** Stable classification travels separately from user-facing wording. */
export class DomainError extends Error {
  readonly name = 'DomainError';

  constructor(readonly kind: DomainErrorKind, readonly code: string, message: string) {
    super(message);
  }
}

export interface SerializedDomainError {
  kind: DomainErrorKind;
  code: string;
}

export function serializeDomainError(error: unknown): SerializedDomainError | undefined {
  return error instanceof DomainError ? { kind: error.kind, code: error.code } : undefined;
}
