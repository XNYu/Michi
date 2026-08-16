import { describe, expect, it } from 'vitest';
import {
  MICHI_CORE_FREQUENCIES,
  MICHI_CORE_RENDERERS,
  michiCoreFrequency,
} from './rendererProfiles';

describe('Michi frequency benchmark profiles', () => {
  it('maps every frequency sweep renderer to its configured semantic parse rate', () => {
    expect(MICHI_CORE_RENDERERS).toEqual([
      'michi-3hz-core',
      'michi-10hz-core',
      'michi-20hz-core',
      'michi-30hz-core',
    ]);
    expect(MICHI_CORE_RENDERERS.map(michiCoreFrequency)).toEqual(MICHI_CORE_FREQUENCIES);
  });

  it('rejects renderer names outside the supported core frequency sweep', () => {
    expect(michiCoreFrequency('michi-3hz-full')).toBeNull();
    expect(michiCoreFrequency('michi-60hz-core')).toBeNull();
    expect(michiCoreFrequency('streamdown-word-core')).toBeNull();
  });
});
