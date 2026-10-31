import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_PREFS } from '../../../state/prefs';
import { AppearancePane } from '../pages/settings/AppearancePane';
import { SETTINGS_SEARCH_INDEX, searchSettings } from './settingsSearch';
import { SETTINGS_GROUPS, SETTINGS_PAGES, pageForSection, settingsPageForRequest, type SettingsPage } from './settingsPages';

vi.mock('../../../state/prefs', async importOriginal => ({
  ...await importOriginal<typeof import('../../../state/prefs')>(),
  usePrefs: () => ({ prefs: DEFAULT_PREFS, setPref: () => {} }),
}));

const ALL_PAGES = Object.keys(SETTINGS_PAGES) as SettingsPage[];
const groupOf = (page: SettingsPage) => SETTINGS_GROUPS.find((group) => group.items.some((item) => item.kind === 'page' && item.page === page))?.title ?? '';
const search = (query: string, pages = ALL_PAGES) => searchSettings(query, pages, groupOf);

describe('Settings pages', () => {
  it('lists every page in exactly one group', () => {
    const listed = SETTINGS_GROUPS.flatMap((group) => group.items.flatMap((item) => item.kind === 'page' ? [item.page] : []));
    expect([...listed].sort()).toEqual([...ALL_PAGES].sort());
  });

  it('opens a page or one of the older sections a request names', () => {
    expect(settingsPageForRequest('meta-agent')).toBe('meta-agent');
    expect(settingsPageForRequest('links')).toBe('links');
    expect(settingsPageForRequest('general')).toBe('machines');
    expect(settingsPageForRequest('data')).toBe('backup');
    expect(settingsPageForRequest('nope')).toBeNull();
    expect(pageForSection('runtime')).toBe('runtime');
  });
});

describe('Settings search', () => {
  it('finds nothing for an empty query', () => {
    expect(search('  ')).toEqual([]);
  });

  it('puts names that start with the query first, then other matches in page order', () => {
    const results = search('sidebar');
    expect(results[0].label).toBe('Sidebar threads per workspace');
    expect(results.map((result) => result.label)).toEqual(expect.arrayContaining(['Sidebar row style', 'Sidebar density', 'Sidebar timestamps']));
    expect(search('sidebar time')[0].label).toBe('Sidebar timestamps');
  });

  it('matches descriptions, keywords and preference keys, and says where each setting is', () => {
    expect(search('yolo')[0]).toMatchObject({ page: 'runtime', label: 'Use global permissions', path: 'Agent › Runtime & model › Permissions' });
    expect(search('theme.codeWrap')[0]).toMatchObject({ label: 'Code wrap', path: 'App › Appearance › Advanced' });
    expect(search('notify')[0]).toMatchObject({ page: 'notifications', path: 'App › Notifications' });
    expect(search('qr')[0]).toMatchObject({ page: 'machines', label: 'Phone access', path: 'Connections › Machines' });
    // Keyboard shortcuts are searchable by what they do.
    expect(search('command palette').map((result) => result.label)).toContain('Open command palette');
  });

  it('ignores case and accents, and every word must match', () => {
    expect(search('RÉDUCE Motion')[0].label).toBe('Reduce motion');
    expect(search('reduce zebra')).toEqual([]);
  });

  it('only searches the pages it is given', () => {
    expect(search('motion', ['notifications'])).toEqual([]);
  });

  it('names Appearance settings as the pane shows them, so a result can find its row', () => {
    render(<AppearancePane />);
    fireEvent.click(screen.getByRole('button', { name: /Advanced/i }));
    const shown = new Set(Array.from(document.querySelectorAll('.settings-field__label')).map((label) => label.textContent));
    const missing = SETTINGS_SEARCH_INDEX.filter((entry) => entry.page === 'appearance' && !shown.has(entry.label)).map((entry) => entry.label);
    expect(missing).toEqual([]);
  });
});
