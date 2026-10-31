import {
  Archive, Bell, CalendarClock, CircleUser, Cpu, ExternalLink, HardDriveDownload, Keyboard, Palette, Server,
  Sparkles, Trash2, type LucideIcon,
} from 'lucide-react';
import type { PageId } from '../../../state/commands';
import { SETTINGS_AREA_SECTIONS, type SettingsAreaSection } from '../../../state/shellArea';

/**
 * Settings pages, one topic each, shared by the phone list and the desktop
 * window. `section` is the older five-section grouping that requests and
 * tests still name (General holds several pages).
 */
export type SettingsPage =
  | 'account' | 'runtime' | 'meta-agent' | 'machines' | 'appearance'
  | 'notifications' | 'links' | 'backup' | 'scheduled' | 'shortcuts';

export interface SettingsPageInfo {
  label: string;
  icon: LucideIcon;
  section: SettingsAreaSection;
  /** Only where it applies: shortcuts need a keyboard, a phone shows the account above its list. */
  only?: 'window' | 'phone';
}

export const SETTINGS_PAGES: Readonly<Record<SettingsPage, SettingsPageInfo>> = {
  runtime: { label: 'Runtime & model', icon: Cpu, section: 'runtime' },
  'meta-agent': { label: 'Meta agent', icon: Sparkles, section: 'meta-agent' },
  /** Connected machines, and phone access, which opens one of them on a phone. */
  machines: { label: 'Machines', icon: Server, section: 'general' },
  appearance: { label: 'Appearance', icon: Palette, section: 'appearance' },
  notifications: { label: 'Notifications', icon: Bell, section: 'general' },
  links: { label: 'Links', icon: ExternalLink, section: 'general' },
  backup: { label: 'Backup & restore', icon: HardDriveDownload, section: 'data' },
  scheduled: { label: 'Scheduled jobs', icon: CalendarClock, section: 'general' },
  shortcuts: { label: 'Keyboard shortcuts', icon: Keyboard, section: 'general', only: 'window' },
  account: { label: 'Account', icon: CircleUser, section: 'general' },
};

/** Trash and Archived are places of their own; Settings lists them beside backup. */
export interface SettingsPlace { id: 'trash' | 'archived'; label: string; icon: LucideIcon; page: PageId }
export const SETTINGS_PLACES: readonly SettingsPlace[] = [
  { id: 'trash', label: 'Trash', icon: Trash2, page: 'trash' },
  { id: 'archived', label: 'Archived', icon: Archive, page: 'archived' },
];

export type SettingsGroupItem = { kind: 'page'; page: SettingsPage } | { kind: 'place'; place: SettingsPlace };

/** The groups both layouts list, in order. Data mixes the two places with backup. */
export const SETTINGS_GROUPS: ReadonlyArray<{ title: string; items: readonly SettingsGroupItem[] }> = [
  { title: 'Agent', items: [{ kind: 'page', page: 'runtime' }, { kind: 'page', page: 'meta-agent' }] },
  { title: 'Connections', items: [{ kind: 'page', page: 'machines' }] },
  { title: 'App', items: [{ kind: 'page', page: 'appearance' }, { kind: 'page', page: 'notifications' }, { kind: 'page', page: 'links' }] },
  { title: 'Data', items: [...SETTINGS_PLACES.map((place) => ({ kind: 'place' as const, place })), { kind: 'page', page: 'backup' }] },
  { title: 'About', items: [{ kind: 'page', page: 'scheduled' }, { kind: 'page', page: 'shortcuts' }, { kind: 'page', page: 'account' }] },
];

export function isSettingsPage(value: unknown): value is SettingsPage {
  return typeof value === 'string' && Object.hasOwn(SETTINGS_PAGES, value);
}

/** The page a request for one of the older sections opens; General opens on its first page. */
export function pageForSection(section: SettingsAreaSection): SettingsPage {
  switch (section) {
    case 'runtime': return 'runtime';
    case 'meta-agent': return 'meta-agent';
    case 'appearance': return 'appearance';
    case 'data': return 'backup';
    case 'general': return 'machines';
  }
}

/** A request names a page, or one of the older sections ('meta-agent' is both). */
export function settingsPageForRequest(value: unknown): SettingsPage | null {
  if (isSettingsPage(value)) return value;
  const section = SETTINGS_AREA_SECTIONS.find((item) => item.id === value);
  return section ? pageForSection(section.id) : null;
}
