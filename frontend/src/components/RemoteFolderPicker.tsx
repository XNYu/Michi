import { useEffect, useState } from 'react';
import { browseRemoteDirectory, type RemoteDirectory } from '../services/api/backendConnections';
import { Button } from './ui/controls';

export function RemoteFolderPicker({ connectionId, onSelect }: {
  connectionId: string; onSelect: (path: string) => void;
}) {
  const [path, setPath] = useState('~');
  const [location, setLocation] = useState('~');
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void browseRemoteDirectory(connectionId, location, controller.signal).then(result => {
      if (!controller.signal.aborted) { setDirectory(result); setPath(result.path); }
    }).catch(failure => {
      if (!controller.signal.aborted) setError((failure as Error).message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connectionId, location]);

  return <div style={{ padding: '10px 14px', background: 'var(--term-surface)', borderBottom: '1px solid var(--term-line)' }}>
    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
      <input aria-label="Browse remote folder" value={path} disabled={loading} onChange={event => setPath(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); setLocation(path); } }}
        style={{ minWidth: 0, flex: 1, padding: '6px 8px', background: 'var(--term-alt)', color: 'var(--term-fg)', border: '1px solid var(--term-line)' }} />
      <Button onClick={() => setLocation(path)} disabled={loading}>Go</Button>
    </div>
    {loading && <div role="status">Loading remote folders…</div>}
    {error && <div role="alert" style={{ color: 'var(--term-danger)' }}>{error}</div>}
    <div style={{ maxHeight: 180, overflowY: 'auto', display: 'grid', gap: 4 }}>
      {directory?.parent && <Button variant="ghost" disabled={loading} onClick={() => setLocation(directory.parent!)}>↑ Parent folder</Button>}
      {directory?.entries.map(entry => <Button variant="ghost" key={entry.path} disabled={loading}
        onClick={() => setLocation(entry.path)}>{entry.name} /</Button>)}
      {directory && !loading && directory.entries.length === 0 && <span style={{ color: 'var(--term-muted)' }}>No subfolders</span>}
    </div>
    {directory && <Button variant="secondary" disabled={loading || !!error} onClick={() => onSelect(directory.path)}
      style={{ marginTop: 10 }}>Use this folder</Button>}
  </div>;
}
