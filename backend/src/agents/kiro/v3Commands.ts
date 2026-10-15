import { configValues, type AcpSessionInfo } from './kiroProtocol';

export const V3_COMMAND_METHODS: Readonly<Record<string, string>> = {
    compact: '_kiro/session/compact', context: '_kiro/session/context',
    history: '_kiro/session/history', export: '_kiro/session/export',
    code: '_kiro/codeIntelligence', usage: '_kiro/account/getUsage',
};

/** CLI 2.28 serves these established methods but omits them from its V3
 * advertisement. Keep this compatibility exception explicit and narrow;
 * -32601 disables a method for the rest of this connection. No other missing
 * advertisement is treated as permission to call an extension. */
export const V3_COMPATIBILITY_METHODS: ReadonlySet<string> = new Set([
    '_session/steer', '_session/steer/clear', '_kiro/account/getUsage',
]);

export function v3CommandNames(info: AcpSessionInfo | undefined, supports: (method: string) => boolean): string[] {
    return ['clear', 'tools', 'mcp', ...(info?.configOptions?.some((c) => c.id === 'effortLevel') ? ['effort'] : []),
        ...Object.keys(V3_COMMAND_METHODS).filter((command) => supports(V3_COMMAND_METHODS[command]))];
}

export function effortSelection(info: AcpSessionInfo | undefined, value: unknown):
    { value: string } | { message: string } {
    const effort = info?.configOptions?.find((option) => option.id === 'effortLevel');
    if (!effort) return { message: 'This Kiro session does not expose configurable effort.' };
    const values = configValues(effort).map((option) => option.value);
    if (typeof value !== 'string' || !values.includes(value)) return {
        message: `Current effort: ${effort.currentValue ?? 'unknown'}. Available: ${values.join(', ') || 'none'}.`,
    };
    return { value };
}
