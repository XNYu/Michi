import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueKeys } from './knip-baseline.mjs';

test('knip issues are keyed by type, file and name, not by position', () => {
  const report = {
    files: ['frontend/src/b.ts', 'frontend/src/a.ts'],
    issues: [
      {
        file: 'backend/src/x.ts',
        exports: [{ name: 'unused', line: 3, col: 1, pos: 10 }],
        types: [],
        duplicates: [[{ name: 'A', line: 1 }, { name: 'default', line: 9 }]],
        enumMembers: { Color: [{ name: 'Red', line: 4 }] },
      },
      { file: 'package.json', dependencies: [{ name: 'left-pad', line: 20 }], unlisted: [] },
    ],
  };
  const moved = structuredClone(report);
  moved.issues[0].exports[0].line = 300;
  assert.deepEqual(issueKeys(report), [
    'dependencies\tpackage.json\tleft-pad',
    'duplicates\tbackend/src/x.ts\tA|default',
    'enumMembers\tbackend/src/x.ts\tColor.Red',
    'exports\tbackend/src/x.ts\tunused',
    'files\tfrontend/src/a.ts',
    'files\tfrontend/src/b.ts',
  ]);
  assert.deepEqual(issueKeys(moved), issueKeys(report));
});
