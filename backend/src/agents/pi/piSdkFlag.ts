export const PI_SESSION_SDK_ENV = "MICHI_PI_SESSION_SDK";

export function isPiSessionSdkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env[PI_SESSION_SDK_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}
