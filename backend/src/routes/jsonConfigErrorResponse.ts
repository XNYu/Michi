import type { Request, Response, NextFunction } from 'express';
import { JsonConfigError } from '../services/jsonConfigStore';

const PUBLIC_MESSAGES: Record<JsonConfigError['code'], string> = {
  CONFIG_LOCKED: 'Configuration is locked by another writer. Retry after it finishes.',
  CONFIG_CORRUPT: 'Saved configuration is invalid and needs repair.',
  CONFIG_READ_FAILED: 'Failed to read saved configuration.',
  CONFIG_WRITE_FAILED: 'Failed to save configuration.',
};

/** Safe JSON diagnostics shared by handled preferences errors and the final HTTP handler. */
export function jsonConfigErrorResponse(error: unknown): { status: 500; body: { error: string; code: JsonConfigError['code'] } } | null {
  if (!(error instanceof JsonConfigError)) return null;
  return {
    status: 500,
    body: {
      error: process.env.MICHI_CLOUD === '1' ? PUBLIC_MESSAGES[error.code] : error.message,
      code: error.code,
    },
  };
}

export function handleJsonConfigError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  const mapped = jsonConfigErrorResponse(error);
  if (!mapped || res.headersSent) { next(error); return; }
  res.status(mapped.status).json(mapped.body);
}
