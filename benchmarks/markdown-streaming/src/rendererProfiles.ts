export const MICHI_CORE_FREQUENCIES = [3, 10, 20, 30] as const;

export type MichiCoreFrequency = (typeof MICHI_CORE_FREQUENCIES)[number];
export type MichiCoreRendererId = `michi-${MichiCoreFrequency}hz-core`;

export const MICHI_CORE_RENDERERS: MichiCoreRendererId[] = MICHI_CORE_FREQUENCIES.map(
  (hz) => `michi-${hz}hz-core` as MichiCoreRendererId,
);

export function michiCoreFrequency(renderer: string): MichiCoreFrequency | null {
  const match = /^michi-(\d+)hz-core$/.exec(renderer);
  if (!match) return null;
  const hz = Number(match[1]);
  return MICHI_CORE_FREQUENCIES.includes(hz as MichiCoreFrequency)
    ? hz as MichiCoreFrequency
    : null;
}
