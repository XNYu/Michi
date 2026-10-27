import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';
import type { DesktopBridge, DesktopInvokeResult, LegacyDesktopBridge } from 'michi-shared';
import { getElectron, type ElectronBridge } from './electronBridge';

afterEach(() => vi.unstubAllGlobals());

it('returns no desktop bridge in a browser or server environment', () => {
  vi.stubGlobal('window', undefined);
  expect(getElectron()).toBeNull();
  vi.stubGlobal('window', {});
  expect(getElectron()).toBeNull();
});

it('keeps old builds valid while callers feature-detect newer methods', async () => {
  const legacy: ElectronBridge = { chooseFolder: async () => ({ canceled: true }), saveMarkdown: async () => ({ canceled: true }) };
  vi.stubGlobal('window', { electron: legacy });
  expect(getElectron()).toBe(legacy);
  expect(getElectron()?.terminalCreate).toBeUndefined();
  expect(await getElectron()?.chooseFolder()).toEqual({ canceled: true });
  expectTypeOf<ElectronBridge>().toExtend<LegacyDesktopBridge>();
  expectTypeOf<Awaited<ReturnType<DesktopBridge['terminalCreate']>>>().toEqualTypeOf<DesktopInvokeResult<'terminal:create'>>();
  expectTypeOf<Awaited<ReturnType<DesktopBridge['getBackgroundServiceStatus']>>>().toEqualTypeOf<DesktopInvokeResult<'service:getStatus'>>();
});
