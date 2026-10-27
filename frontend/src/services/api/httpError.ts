/** Preserve the response status so background callers can distinguish invalid
 * configuration from a Backend that is still starting. */
export class HttpResponseError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'HttpResponseError';
  }
}

export async function responseError(response: Response, operation: string): Promise<HttpResponseError> {
  const payload: unknown = await response.json().catch(() => null);
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  return new HttpResponseError(
    typeof body?.error === 'string' ? body.error : `${operation} failed: ${response.status}`,
    response.status,
    typeof body?.code === 'string' ? body.code : undefined,
  );
}

export function shouldRetryRequest(error: unknown): boolean {
  if (error instanceof HttpResponseError) {
    return error.status >= 500 || [408, 425, 429].includes(error.status);
  }
  // Network failures have no HTTP response and may recover during cold start.
  return true;
}

export function requestRetryDelay(failedAttempts: number): number {
  return Math.min(500 * 2 ** (failedAttempts - 1), 5_000);
}
