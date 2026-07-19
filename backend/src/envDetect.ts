export type EnvType = 'agentspace' | 'devspace' | 'local';

export interface EnvInfo {
  type: EnvType;
  region?: string;
  devspaceId?: string;
}

export function detectEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  hostname?: string,
): EnvInfo {
  // Lookup chain for region:
  //   AWS_REGION         — standard AWS SDK env var
  //   AWS_DEFAULT_REGION — older AWS SDK env var (set by some platforms)
  //   HOSTNAME env var   — DevSpaces sets HOSTNAME to ip-X-X-X-X.<region>.compute.internal
  //   hostname argument  — caller-provided override (mainly for tests)
  const hostnameSource = hostname ?? env.HOSTNAME;
  const region =
    env.AWS_REGION ??
    env.AWS_DEFAULT_REGION ??
    hostnameSource?.match(/^ip-\d+-\d+-\d+-\d+\.([a-z]{2}-[a-z]+-\d+)\./)?.[1];
  if (env.AGENTSPACE_ID) {
    return { type: 'agentspace', region, devspaceId: env.DEVSPACE_ID };
  }
  if (env.DEVSPACE_ID) {
    return { type: 'devspace', region, devspaceId: env.DEVSPACE_ID };
  }
  return { type: 'local' };
}

export function buildProxyUrl(devspaceId: string, region: string, port: number): string {
  return `https://${devspaceId}--${port}.${region}.prod.proxy.devspaces.amazon.dev`;
}

export function printEnvInfo(port: number): void {
  const info = detectEnvironment();
  const url = info.devspaceId && info.region
    ? buildProxyUrl(info.devspaceId, info.region, port)
    : `http://localhost:${port}`;
  // Stable marker for agentspace-start.sh to grep. Do NOT change format.
  // Always emitted on listen — when not in devspaces, falls back to localhost.
  console.log(`[env] Access via: ${url}`);
}
