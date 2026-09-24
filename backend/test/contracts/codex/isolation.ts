import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

// This import must precede Runtime/Session imports: config and logger read env at load.
const root = mkdtempSync(path.join(tmpdir(), 'michi-codex-contract-'));
process.env.MICHI_DATA_DIR = path.join(root, 'data');
process.env.MICHI_LOG_DIR = path.join(root, 'logs');
after(() => rmSync(root, { recursive: true, force: true }));
