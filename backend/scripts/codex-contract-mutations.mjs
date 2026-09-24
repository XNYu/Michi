import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = {
  'compact-spelling': 'compact lifecycle',
  'declined-as-completed': 'terminal lifecycle',
  'question-label-as-id': 'wire input',
};
const run = (mutation) => spawnSync(process.execPath, [
  '--require', 'ts-node/register',
  ...(mutation ? ['--require', './test/contracts/codex/mutation-hook.cjs'] : []),
  '--test', '--test-reporter=tap', '--test-timeout=30000', 'test/codexContract.test.ts',
], { cwd, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, MICHI_CODEX_CONTRACT_MUTATION: mutation ?? '' },
});
const baseline = run();
if (baseline.status !== 0) {
  process.stderr.write(baseline.stdout + baseline.stderr);
  throw new Error('Unmutated contract suite must pass first');
}
console.log('Unmutated contract suite passed.');
for (const [mutation, testName] of Object.entries(cases)) {
  const result = run(mutation);
  if (result.status !== 1 || !new RegExp(`not ok \\d+ - Codex contract: ${testName}`).test(result.stdout)) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`Mutation was not rejected by its intended contract: ${mutation}`);
  }
  console.log(`Caught ${mutation} in ${testName}.`);
}
