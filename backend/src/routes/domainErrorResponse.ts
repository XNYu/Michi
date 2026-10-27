import { DomainError } from '../services/domainErrors';

const statuses = { invalid_argument: 400, not_found: 404, conflict: 409 } as const;

/** Keep the existing { error } response shape and classify unexpected failures as 500. */
export function domainErrorResponse(error: unknown): { status: number; error: string } {
  return error instanceof DomainError
    ? { status: statuses[error.kind], error: error.message }
    : { status: 500, error: 'Internal server error' };
}
