// pi 0.80.0 moved the free-function catalog API (getModel/getModels/streamSimple/…)
// off the "@earendil-works/pi-ai" ROOT entrypoint. The root now exposes only the
// Models class / createModels() instance API; the free functions we call
// (piMod.getModel/getModels/streamSimple, in PiSession/piProviders) survive on the
// "@earendil-works/pi-ai/compat" subpath (a strict superset — it re-exports the
// root via `export * from "./index.ts"`, so `Type` comes along too). /compat is
// @deprecated upstream and slated for removal; the long-term migration is to
// createModels()/provider factories.
//
// We import /compat at RUNTIME (both the esbuild-bundled path and the ts-node
// dynamic path resolve it via the package `exports` map). We do NOT reference
// "@earendil-works/pi-ai/compat" as a TS type, though: this backend uses
// `moduleResolution: "node"` (node10), which predates `exports` maps and cannot
// resolve subpaths (TS2307). So PiAiModule is typed off the root package and
// widened with the moved catalog functions so callers stay typed. Every consumer
// already casts `(piMod as any)` before calling these, so the widening is a
// type-only convenience, not a correctness dependency.
type PiAiRoot = typeof import("@earendil-works/pi-ai");
type PiAiModule = PiAiRoot & {
    getModel: (provider: string, id: string) => any;
    getModels: (provider?: string) => any[];
    streamSimple: (model: any, context: any, options?: any) => AsyncIterableIterator<any>;
};
type PiAgentCoreModule = typeof import("@earendil-works/pi-agent-core");

declare const __MICHIBUNDLE__: boolean | undefined;

const nativeDynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;

let piAiPromise: Promise<PiAiModule> | null = null;
let piAgentCorePromise: Promise<PiAgentCoreModule> | null = null;

export async function loadPiAi(): Promise<PiAiModule> {
    if (!piAiPromise) {
        piAiPromise = loadPiAiModule();
    }
    return piAiPromise;
}

export async function loadPiAgentCore(): Promise<PiAgentCoreModule> {
    if (!piAgentCorePromise) {
        piAgentCorePromise = loadPiAgentCoreModule();
    }
    return piAgentCorePromise;
}

async function loadPiAiModule(): Promise<PiAiModule> {
    if (typeof __MICHIBUNDLE__ !== "undefined" && __MICHIBUNDLE__) {
        // esbuild resolves the /compat subpath via the package `exports` map at
        // bundle time; tsc (moduleResolution:"node") cannot, so silence the
        // type-only TS2307 here — this branch never runs under ts-node.
        // @ts-ignore - /compat unresolvable under node10 moduleResolution; runtime + esbuild handle it
        return import("@earendil-works/pi-ai/compat") as Promise<PiAiModule>;
    }
    return nativeDynamicImport("@earendil-works/pi-ai/compat") as Promise<PiAiModule>;
}

async function loadPiAgentCoreModule(): Promise<PiAgentCoreModule> {
    if (typeof __MICHIBUNDLE__ !== "undefined" && __MICHIBUNDLE__) {
        return import("@earendil-works/pi-agent-core");
    }
    return nativeDynamicImport("@earendil-works/pi-agent-core") as Promise<PiAgentCoreModule>;
}
