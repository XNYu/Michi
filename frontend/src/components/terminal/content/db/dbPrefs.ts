import { type MichiDbViewType } from 'michi-shared';
// Keep this local preference key stable across the content module rename.
const groupKey = (dbId: string, viewId: string) => `michi:desk:db-group:${dbId}:${viewId}`;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the page opens on its defaults next time.
  }
}

export function pickView<T extends { id: string; type: MichiDbViewType }>(views: readonly T[], wanted: string | null): T | undefined {
  if (!views.length) return undefined;
  return views.find((v) => v.id === wanted) ?? views.find((v) => v.type === wanted) ?? views[0];
}

export interface GroupPrefs {
  showCounts: boolean;
  /** Number columns whose sum shows on each group. */
  sums: string[];
  hideEmpty: boolean;
}

export function defaultGroupPrefs(type: MichiDbViewType): GroupPrefs {
  // A board keeps empty columns to drop into; a table shows only groups with rows.
  return { showCounts: true, sums: [], hideEmpty: type !== 'board' };
}

export function readGroupPrefs(dbId: string, viewId: string, type: MichiDbViewType): GroupPrefs {
  const base = defaultGroupPrefs(type);
  const raw = read(groupKey(dbId, viewId));
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<GroupPrefs>;
    return {
      showCounts: typeof v.showCounts === 'boolean' ? v.showCounts : base.showCounts,
      sums: Array.isArray(v.sums) ? v.sums.filter((x): x is string => typeof x === 'string') : base.sums,
      hideEmpty: typeof v.hideEmpty === 'boolean' ? v.hideEmpty : base.hideEmpty,
    };
  } catch {
    return base;
  }
}

export function writeGroupPrefs(dbId: string, viewId: string, prefs: GroupPrefs): void {
  write(groupKey(dbId, viewId), JSON.stringify(prefs));
}
