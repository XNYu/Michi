import { createHash } from 'node:crypto';
import type { RuntimeToolProfile } from '../../agents/types';
import { buildExtractionInstructions } from './extractionPolicy';

/**
 * The closed tool session of automatic memory extraction: four host tools
 * (extractionTools.ts) and nothing else. It is a Meta agent maintenance
 * profile (restricted, no shell, files, network or external MCP tools), so
 * every adapter runs its closed tool-catalog check against these names.
 */

export const MEMORY_EXTRACTION_TOOL_NAMES = ['memory_read_source', 'memory_search', 'memory_propose', 'memory_no_change'] as const;

export type MemoryExtractionToolName = typeof MEMORY_EXTRACTION_TOOL_NAMES[number];

export function isMemoryExtractionToolName(name: string): name is MemoryExtractionToolName {
  return (MEMORY_EXTRACTION_TOOL_NAMES as readonly string[]).includes(name);
}

/** Constructed by the backend for a scheduled extraction node only; never from request data. */
export function memoryExtractionToolProfile(): RuntimeToolProfile {
  return {
    allowedToolNames: MEMORY_EXTRACTION_TOOL_NAMES,
    maintenance: true,
    restricted: true,
    metaAgentToolset: 'memory',
  };
}

export function memoryExtractionProfileHash(runtimeConfig: { runtimeId: string; providerId: string | null; modelId: string | null; reasoning: string | null }): string {
  return createHash('sha256').update(JSON.stringify({ profile: 'memory-extraction-1', toolNames: MEMORY_EXTRACTION_TOOL_NAMES, ...runtimeConfig })).digest('hex');
}

/** The session's system instructions: the extraction policy with this session's tool names. */
export function memoryExtractionBootstrapInstructions(): string {
  const [readSource, search, propose, noChange] = MEMORY_EXTRACTION_TOOL_NAMES;
  return buildExtractionInstructions({ toolNames: { readSource, search, propose, noChange } });
}
