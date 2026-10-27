import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PageDto, PageLayoutRule } from 'michi-shared';
import { SpaceSettings } from './SpaceSettings';

const api = vi.hoisted(() => ({ fetchLayoutRules: vi.fn(), addLayoutRule: vi.fn(), deleteLayoutRule: vi.fn(), fetchLayoutPreferences: vi.fn(), saveLayoutPreferences: vi.fn() }));
vi.mock('../../../services/api/spacesHome', () => api);
vi.mock('./MaintenanceStatus', () => ({ MaintenanceStatus: () => <span>Maintenance controls</span> }));
const page: PageDto = { id: 'p1', title: 'Launch', workspaceId: 'w1', parentId: null, position: 0, color: null, revision: 2, viewVersion: 1, blocks: [], updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null };
let rules: PageLayoutRule[];
beforeEach(() => {
  vi.clearAllMocks();
  rules = [];
  api.fetchLayoutPreferences.mockResolvedValue({ text: '', revision: 0, updatedAt: null, updatedBy: null });
  api.fetchLayoutRules.mockImplementation(async () => rules);
  api.addLayoutRule.mockImplementation(async (_id, input) => { rules = [{ id: 'r1', text: input.text, createdBy: 'user', createdAt: 1, sourceMessage: null }]; return rules; });
  api.deleteLayoutRule.mockImplementation(async () => { rules = []; return rules; });
});
const view = (onRename = vi.fn().mockResolvedValue(undefined)) => render(<SpaceSettings page={page} connectionId="local" spaceId="p1" spaceTitle="Launch" onBack={vi.fn()} onRename={onRename} onComponents={vi.fn()} />);

it('renames the page and keeps the draft when saving fails', async () => {
  const rename = vi.fn().mockRejectedValueOnce(new Error('Page changed. Try again.')).mockResolvedValue(undefined);
  view(rename);
  fireEvent.change(screen.getByLabelText('Page name'), { target: { value: ' Launch plan ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Page changed. Try again.');
  expect(screen.getByLabelText('Page name')).toHaveProperty('value', ' Launch plan ');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await screen.findByText('Saved');
  expect(rename).toHaveBeenLastCalledWith('Launch plan');
});

it('adds a suggested rule, reads it back, and deletes it', async () => {
  view();
  await screen.findByText('No layout rules yet.');
  fireEvent.click(screen.getByRole('button', { name: 'Put risks first' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  const remove = await screen.findByRole('button', { name: 'Delete rule: Put risks first' });
  expect(api.addLayoutRule).toHaveBeenCalledWith('p1', { text: 'Put risks first' }, 'local');
  fireEvent.click(remove);
  await screen.findByText('No layout rules yet.');
  expect(api.deleteLayoutRule).toHaveBeenCalledWith('p1', 'r1', 'local');
});

it('reports the initial rules error and recovers on Retry', async () => {
  api.fetchLayoutRules.mockRejectedValueOnce(new Error('Unavailable'));
  view();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Unavailable Retry');
  expect(screen.queryByText('Loading rules…')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByText('No layout rules yet.');
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
