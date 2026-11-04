// Preloaded by the backend test runner (see test:raw). Without it a test would open the user's own ~/.michi
// (data.db, config.json, logs). Each test file's process gets its own temporary directories, removed when it
// exits. Values a test sets itself are kept: a test sets them in code (after this preload) or in the env of a
// child process it spawns, and such descendants see MICHI_TEST_ISOLATED_ROOT and keep what they inherit.
//
// Values inherited from the developer's shell are replaced, not kept: a shell that exports
// MICHI_DATA_DIR=~/.michi would otherwise point every test at the real database, and exported remote-access or
// auth settings would change how routes authenticate. Set MICHI_TEST_KEEP_ENV_DIRS=1 to keep inherited
// directories deliberately.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIRS = [['MICHI_DATA_DIR', 'data'], ['MICHI_CONFIG_DIR', 'config'], ['MICHI_LOG_DIR', 'logs']];
// Deployment settings a developer shell may export for a running backend; tests that need them set them in code.
const SHELL_ONLY = ['MICHI_REMOTE_ACCESS', 'MICHI_REMOTE_TOKEN', 'MICHI_BIND_HOST', 'MICHI_CLOUD', 'MICHI_REQUIRE_AUTH'];

// The runner's own process only spawns one child per file; its directories would be shared by all of them.
const runnerParent = !process.env.NODE_TEST_CONTEXT && process.execArgv.includes('--test');
// A process spawned by an already isolated test inherits that test's choices.
const descendant = Boolean(process.env.MICHI_TEST_ISOLATED_ROOT);

if (!runnerParent && !descendant) {
  const keepInherited = process.env.MICHI_TEST_KEEP_ENV_DIRS === '1';
  const dirs = DIRS.filter(([name]) => !(keepInherited && process.env[name]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-test-dirs-'));
  for (const [name, sub] of dirs) process.env[name] = path.join(root, sub);
  for (const name of SHELL_ONLY) delete process.env[name];
  process.env.MICHI_TEST_ISOLATED_ROOT = root;
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
}
