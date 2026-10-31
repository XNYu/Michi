import { useRef, useState } from 'react';
import { Button } from '../../../ui/controls';
import { downloadBackup, exportBackup, MAX_BACKUP_BYTES, parseBackup, restoreBackup, type PortableBackup } from '../../../../services/api/backup';

export function BackupPane() {
  const input = useRef<HTMLInputElement>(null);
  const locked = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{ name: string; backup: PortableBackup } | null>(null);
  const [notice, setNotice] = useState<{ error?: boolean; text: string } | null>(null);
  const [restored, setRestored] = useState(false);

  async function run(label: string, action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(label);
    setNotice(null);
    try { await action(); }
    catch (error) { setNotice({ error: true, text: error instanceof Error ? error.message : 'The operation failed.' }); }
    finally { locked.current = false; setBusy(null); }
  }

  return <section className="settings-backup" aria-labelledby="settings-backup-title" aria-busy={!!busy}>
    <h2 id="settings-backup-title" className="settings-backup__title">Backup and restore</h2>
    <div className="settings-backup__intro">
      <p>Export workspaces, conversations and Agent data from this server as a JSON file.</p>
      <p>Pages, databases, attachment files, scheduled jobs, credentials and local settings are not included. Connected remote machines are not included.</p>
    </div>
    <div className="settings-backup__card">
    <div className="settings-backup__actions">
      <Button disabled={!!busy} onClick={() => void run('Exporting backup…', async () => {
        downloadBackup(await exportBackup());
        setNotice({ text: 'Backup download started.' });
      })}>Export backup</Button>
      <Button disabled={!!busy || restored} onClick={() => input.current?.click()}>Choose backup…</Button>
      <input ref={input} type="file" accept=".json,application/json" aria-label="Backup file" hidden
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          void run('Reading backup…', async () => {
            setPending(null);
            if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup files must be 50 MiB or smaller.');
            const backup = parseBackup(await file.text());
            setPending({ name: file.name, backup });
          });
        }} />
    </div>
    {pending && !restored && <div className="settings-backup__preview">
      <strong>{pending.name}</strong>
      <p>{pending.backup.workspaces.length} workspace(s)
        {typeof pending.backup.exportedAt === 'number' && Number.isFinite(new Date(pending.backup.exportedAt).getTime())
          ? ` · Exported ${new Date(pending.backup.exportedAt).toLocaleString()}` : ''}</p>
      <p>Restore creates new copies. Existing workspaces are kept. Importing the same backup again creates duplicates.</p>
      <div className="settings-backup__actions">
        <Button variant="primary" disabled={!!busy} onClick={() => void run('Restoring backup…', async () => {
          const result = await restoreBackup(pending.backup);
          setRestored(true);
          setPending(null);
          setNotice({ text: `Restored ${result.workspaceCount} workspace(s). Reload when you are ready to open them.` });
        })}>Restore backup</Button>
        <Button variant="ghost" disabled={!!busy} onClick={() => setPending(null)}>Cancel</Button>
      </div>
    </div>}
    {busy && <p role="status">{busy}</p>}
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    {restored && <Button onClick={() => window.location.reload()}>Reload Michi</Button>}
    </div>
  </section>;
}
