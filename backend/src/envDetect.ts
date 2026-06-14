export type EnvType = 'remote' | 'local';

export interface EnvInfo {
  type: EnvType;
  publicUrl?: string;
}

export function detectEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  _hostname?: string,
): EnvInfo {
  const publicUrl = env.MICHI_PUBLIC_URL;
  if (publicUrl) {
    return { type: 'remote', publicUrl };
  }
  return { type: 'local' };
}

export function printEnvInfo(port: number): void {
  const info = detectEnvironment();
  const url = info.publicUrl ?? `http://localhost:${port}`;
  // Stable startup marker for local launchers. Do NOT change format.
  console.log(`[env] Access via: ${url}`);
}
