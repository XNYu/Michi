import type { Config } from 'drizzle-kit';
import path from 'path';
import os from 'os';

const dataDir = process.env.MICHI_DATA_DIR ?? path.join(os.homedir(), '.michi');

const config: Config = {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: path.join(dataDir, 'data.db'),
  },
};

export default config;

// Note: a separate drizzle config for audit.db (auditSchema.ts /
// auditMigrations/) will be added in P1.7.
