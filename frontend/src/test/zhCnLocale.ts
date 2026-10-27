import { vi } from 'vitest';

type LocaleMethod = 'toLocaleDateString' | 'toLocaleString' | 'toLocaleTimeString';

/**
 * Makes zh-CN the default locale of Date's toLocale*String and of
 * Intl.DateTimeFormat, as on a browser set to Chinese. Restore with
 * vi.restoreAllMocks().
 */
export function useZhCnDefaultLocale(): void {
  for (const method of ['toLocaleDateString', 'toLocaleString', 'toLocaleTimeString'] as LocaleMethod[]) {
    const original = Date.prototype[method];
    vi.spyOn(Date.prototype, method).mockImplementation(function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
      return original.call(this, locales ?? 'zh-CN', options);
    });
  }
  const DateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return new DateTimeFormat(locales ?? 'zh-CN', options);
  } as typeof Intl.DateTimeFormat);
}
