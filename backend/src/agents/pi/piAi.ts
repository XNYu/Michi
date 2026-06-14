type PiAiModule = typeof import("@earendil-works/pi-ai");
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
        return import("@earendil-works/pi-ai");
    }
    return nativeDynamicImport("@earendil-works/pi-ai") as Promise<PiAiModule>;
}

async function loadPiAgentCoreModule(): Promise<PiAgentCoreModule> {
    if (typeof __MICHIBUNDLE__ !== "undefined" && __MICHIBUNDLE__) {
        return import("@earendil-works/pi-agent-core");
    }
    return nativeDynamicImport("@earendil-works/pi-agent-core") as Promise<PiAgentCoreModule>;
}
