import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Data and config defaults shared by `dev`, `backend:dev` and `electron:dev`. */
export function devDataEnvironment(env = process.env) {
  const dataDir = env.MICHI_DATA_DIR || path.join(os.homedir(), '.michi-dev');
  return {
    ...env,
    MICHI_DATA_DIR: dataDir,
    // Runtime/model and UI preferences otherwise default to ~/.michi, the
    // installed app's config, and a dev backend would overwrite them.
    MICHI_CONFIG_DIR: env.MICHI_CONFIG_DIR || dataDir,
  };
}

/** Checkouts with the same folder name must not share Electron's instance lock. */
export function electronDevEnvironment(root, env = process.env) {
  const checkout = path.resolve(root);
  const checkoutHash = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
  const instanceId = env.MICHI_DEV_INSTANCE_ID || `${path.basename(checkout)}-${checkoutHash}`;
  const devEnv = devDataEnvironment(env);
  const dataDir = devEnv.MICHI_DATA_DIR;
  return {
    ...devEnv,
    MICHI_DEV_INSTANCE_ID: instanceId,
    MICHI_ELECTRON_USER_DATA_DIR:
      env.MICHI_ELECTRON_USER_DATA_DIR || path.join(dataDir, `electron-${instanceId}`),
  };
}

// `node scripts/electron-dev-env.mjs <checkout>` prints, as KEY=value lines,
// the variables electronDevEnvironment() sets, for shell launchers such as
// scripts/bench-startup.sh.
const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  const env = electronDevEnvironment(process.argv[2] ?? process.cwd());
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] !== value) console.log(`${key}=${value}`);
  }
}
