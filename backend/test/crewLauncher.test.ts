import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

test('portable Crew launcher handles version, pinned Node, fallback and spaces', (t) => {
    const python = process.env.MICHI_CREW_TEST_PYTHON || 'python3';
    const check = spawnSync(python, ['--version']);
    if (check.error && (check.error as NodeJS.ErrnoException).code === 'ENOENT') return t.skip('Python is not installed; official Crew includes its own interpreter');
    const result = execFileSync(python, ['-I', path.join(__dirname, 'crewLauncher.test.py')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(result, '');
});
