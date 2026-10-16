import { retryRemoteWorkspace, useRemoteRecoveryIssues } from '../state/remoteRecovery';
import { RemoteDiagnostics } from './RemoteDiagnostics';
import { Button } from './ui/controls';
import './RemoteConnection.css';

export function RemoteRecoveryBanner() {
  const issues = useRemoteRecoveryIssues();
  if (!issues.length) return null;
  return <div className="remote-recovery-list" role="region" aria-label="Remote connection issues">
    {issues.map(issue => <section key={issue.connectionId} className="remote-recovery" aria-label={'Remote recovery: ' + issue.name}>
      <div className="remote-recovery__heading">
        <p role="status"><strong>Reconnecting to {issue.name}</strong> · {issue.retrying ? 'Trying now…' : 'Retrying automatically'}</p>
        <Button size="sm" disabled={issue.retrying} onClick={() => retryRemoteWorkspace(issue.connectionId)}>Try again</Button>
      </div>
      <p className="remote-connection-notice" data-tone="error">Could not restore remote workspaces: {issue.diagnostic.message}</p>
      <RemoteDiagnostics report={issue.diagnostic} />
    </section>)}
  </div>;
}
