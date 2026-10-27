// Preloaded by the backend test runner (see test:raw). A test that sets no MICHI_DATA_DIR, MICHI_CONFIG_DIR or
// MICHI_LOG_DIR would otherwise open the user's own ~/.michi (data.db, config.json, logs). Each test file's
// process gets its own temporary directories, removed when it exits; values a test sets itself are kept.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The runner's own process only spawns one child per file; its directories would be shared by all of them.
const runnerParent = !process.env.NODE_TEST_CONTEXT && process.execArgv.includes('--test');

if (!runnerParent) {
  const dirs = [['MICHI_DATA_DIR', 'data'], ['MICHI_CONFIG_DIR', 'config'], ['MICHI_LOG_DIR', 'logs']]
    .filter(([name]) => !process.env[name]);
  if (dirs.length) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-test-dirs-'));
    for (const [name, sub] of dirs) process.env[name] = path.join(root, sub);
    process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  }
}
