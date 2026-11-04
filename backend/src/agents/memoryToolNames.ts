/** Names of the Michi Memory agent tools; kept dependency-free for the tool catalog and permission policy. */
export const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_save",
  "memory_update",
  "memory_delete",
] as const;

export type MemoryToolName = typeof MEMORY_TOOL_NAMES[number];

export function isMemoryToolName(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}
