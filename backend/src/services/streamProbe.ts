export const BACKEND_STREAM_PROBE_ENABLED = process.env.MICHI_STREAM_PROBE === "1";

export function writeBackendStreamProbe(row: Record<string, unknown>): void {
    if (!BACKEND_STREAM_PROBE_ENABLED) return;
    console.log(JSON.stringify({ type: "stream_probe", source: "backend", ...row }));
}
