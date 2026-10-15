/** Learned memory policy; chat history is retained independently. */
export type CrewMemoryMode = 'persistent' | 'incognito' | 'temporary';

export function isCrewMemoryMode(value: unknown): value is CrewMemoryMode {
  return value === 'persistent' || value === 'incognito' || value === 'temporary';
}
