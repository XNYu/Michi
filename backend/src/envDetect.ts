export function printEnvInfo(port: number): void {
  const url = process.env.MICHI_PUBLIC_URL || `http://localhost:${port}`;
  console.log(`[env] Access via: ${url}`);
}
