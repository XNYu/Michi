import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupPane } from './BackupPane';
import { downloadBackup, exportBackup, restoreBackup } from '../../../../services/api/backup';

vi.mock('../../../../services/api/backup', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../services/api/backup')>(),
  exportBackup: vi.fn(), restoreBackup: vi.fn(), downloadBackup: vi.fn(),
}));
const backup = { app: 'michi' as const, version: 1 as const, workspaces: [
  { workspace: { id: 'original' }, trees: [], nodes: [], edges: [], messages: [], contexts: [] },
] };
function choose(text: string) {
  fireEvent.change(screen.getByLabelText('Backup file'), { target: { files: [
    { name: 'backup.json', size: text.length, text: () => Promise.resolve(text) },
  ] } });
}
beforeEach(() => vi.clearAllMocks());
describe('Backup and restore', () => {
  it('exports the server backup', async () => {
    vi.mocked(exportBackup).mockResolvedValue(backup);
    render(<BackupPane />);
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(downloadBackup).toHaveBeenCalledWith(backup));
  });
  it('previews before restoring once and offers reload', async () => {
    vi.mocked(restoreBackup).mockResolvedValue({ workspaceCount: 1 });
    render(<BackupPane />);
    choose(JSON.stringify(backup));
    const restore = await screen.findByRole('button', { name: 'Restore backup' });
    expect(restoreBackup).not.toHaveBeenCalled();
    fireEvent.click(restore);
    fireEvent.click(restore);
    await screen.findByRole('button', { name: 'Reload Michi' });
    expect(restoreBackup).toHaveBeenCalledExactlyOnceWith(backup);
    expect(screen.queryByRole('button', { name: 'Restore backup' })).toBeNull();
  });
  it('rejects malformed files without importing', async () => {
    render(<BackupPane />);
    choose('{broken');
    expect((await screen.findByRole('alert')).textContent).toContain('valid JSON');
    expect(restoreBackup).not.toHaveBeenCalled();
  });
  it('keeps the preview after a server failure', async () => {
    vi.mocked(restoreBackup).mockRejectedValue(new Error('Invalid backup: foreign reference'));
    render(<BackupPane />);
    choose(JSON.stringify(backup));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore backup' }));
    expect((await screen.findByRole('alert')).textContent).toContain('foreign reference');
    expect(screen.queryByRole('button', { name: 'Reload Michi' })).toBeNull();
  });
});
