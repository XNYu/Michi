import fs from 'fs';
import os from 'os';
import path from 'path';

export function getMichiDataDir(): string {
  const dir = process.env.MICHI_DATA_DIR || path.join(os.homedir(), '.michi');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
