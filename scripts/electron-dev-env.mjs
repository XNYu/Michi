import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Checkouts with the same folder name must not share Electron's instance lock. */
export function electronDevEnvironment(root, env = process.env) {
  const checkout = path.resolve(root);
  const checkoutHash = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
  const instanceId = env.MICHI_DEV_INSTANCE_ID || `${path.basename(checkout)}-${checkoutHash}`;
  const dataDir = env.MICHI_DATA_DIR || path.join(os.homedir(), '.michi-dev');
  return {
    ...env,
    MICHI_DATA_DIR: dataDir,
    // Runtime/model and UI preferences otherwise default to ~/.michi, the
    // installed app's config, and a dev backend would overwrite them.
    MICHI_CONFIG_DIR: env.MICHI_CONFIG_DIR || dataDir,
    MICHI_DEV_INSTANCE_ID: instanceId,
    MICHI_ELECTRON_USER_DATA_DIR:
      env.MICHI_ELECTRON_USER_DATA_DIR || path.join(dataDir, `electron-${instanceId}`),
  };
}
