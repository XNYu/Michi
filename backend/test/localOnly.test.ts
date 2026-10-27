import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { localOnlyGuard } from '../src/routes/middleware/localOnly';

test('native local-only routes still reject DNS rebinding hostnames', () => {
  const [hostGuard] = localOnlyGuard('Local only');
  for (const host of ['evil.example:3000', '', 'localhost.evil.example']) {
    let status: number | undefined;
    let body: unknown;
    const res = { status(code: number) { status = code; return this; }, json(value: unknown) { body = value; } } as unknown as Response;
    hostGuard({ headers: { host } } as Request, res, () => assert.fail('non-local host reached handler'));
    assert.equal(status, 403);
    assert.deepEqual(body, { error: 'Local only' });
  }
  for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
    let next = false;
    hostGuard({ headers: { host } } as Request, {} as Response, () => { next = true; });
    assert.equal(next, true);
  }
});
