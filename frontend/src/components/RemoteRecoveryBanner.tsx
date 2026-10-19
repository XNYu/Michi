import { useEffect, useState } from 'react';
import { ChevronRight, ServerOff, X } from 'lucide-react';
import { dismissRemoteRecoveryIssues, retryRemoteWorkspace, useRemoteRecoveryIssues, type RemoteRecoveryIssue } from '../state/remoteRecovery';
import { RemoteDiagnostics } from './RemoteDiagnostics';
import { Button } from './ui/controls';
import { DrawerShell, type DrawerShellProps } from './ui/DrawerShell';
import './RemoteConnection.css';

function recoveryLabel(issues: readonly RemoteRecoveryIssue[]) {
  return issues.length === 1 ? `${issues[0].name} is unavailable` : `${issues.length} remotes unavailable`;
}

export function RemoteRecoveryIndicator({ onOpenDetails }: { onOpenDetails: () => void }) {
  const issues = useRemoteRecoveryIssues();
  if (!issues.length) return null;
  return <Button variant="ghost" size="sm" className="remote-recovery-indicator" onClick={onOpenDetails}
    aria-label={`Remote connection details: ${recoveryLabel(issues)}`} aria-haspopup="dialog" title={recoveryLabel(issues)}>
    <ServerOff size={14} aria-hidden="true" />
    <span aria-hidden="true">{issues.length}</span>
  </Button>;
}

export function RemoteRecoveryBanner({ onOpenDetails }: { onOpenDetails: () => void }) {
  const issues = useRemoteRecoveryIssues();
  if (!issues.some(issue => !issue.dismissed)) return null;
  return <div className="remote-recovery-notice" role="region" aria-label="Remote connection issues">
    <ServerOff className="remote-recovery-notice__icon" size={14} aria-hidden="true" />
    <p className="remote-recovery-notice__summary" role="status" title={issues.map(issue => issue.name).join(', ')}>
      <strong>{recoveryLabel(issues)}</strong>
      <span className="remote-recovery-notice__status">Reconnecting automatically</span>
    </p>
    <Button variant="ghost" size="sm" onClick={onOpenDetails} aria-haspopup="dialog">Details <ChevronRight size={12} aria-hidden="true" /></Button>
    <Button variant="ghost" size="sm" className="remote-recovery-notice__dismiss" onClick={dismissRemoteRecoveryIssues}
      aria-label="Dismiss remote connection notice" title="Hide notice; reconnection continues">
      <X size={14} aria-hidden="true" />
    </Button>
  </div>;
}

export function RemoteRecoveryDrawer({ open, onClose, motion, onPresenceChange }: Pick<DrawerShellProps, 'open' | 'onClose' | 'motion' | 'onPresenceChange'>) {
  const issues = useRemoteRecoveryIssues();
  useEffect(() => {
    if (open && !issues.length) onClose();
  }, [open, issues.length, onClose]);
  return <DrawerShell open={open && issues.length > 0} onClose={onClose} title="Remote connections" width={480}
    motion={motion} onPresenceChange={onPresenceChange}>
    <div className="remote-recovery-details">
      <div className="remote-recovery-details__intro">
        <h2>{issues.length ? `${issues.length} remote${issues.length === 1 ? '' : 's'} unavailable` : 'All remotes reconnected'}</h2>
        <p>Michi will keep trying to reconnect. You can continue working locally.</p>
      </div>
      {issues.map(issue => <RemoteRecoveryMachine key={issue.connectionId} issue={issue} />)}
    </div>
  </DrawerShell>;
}

function RemoteRecoveryMachine({ issue }: { issue: RemoteRecoveryIssue }) {
  const [expanded, setExpanded] = useState(false);
  return <section className="remote-recovery-machine" aria-label={`Remote recovery: ${issue.name}`}>
    <div className="remote-recovery-machine__heading">
      <ServerOff size={16} aria-hidden="true" />
      <h3>{issue.name}</h3>
      <Button size="sm" disabled={issue.retrying} onClick={() => retryRemoteWorkspace(issue.connectionId)}>{issue.retrying ? 'Trying…' : 'Try again'}</Button>
    </div>
    <p className="remote-recovery-machine__status" role="status">{issue.retrying ? issue.diagnostic.severity === 'info' ? issue.diagnostic.message : 'Reconnecting now…' : 'Waiting to reconnect automatically'}</p>
    <details className="remote-recovery-machine__diagnostics" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>Connection details</summary>
      {expanded && <>
        <p className="remote-recovery-machine__error">{issue.diagnostic.message}</p>
        <RemoteDiagnostics report={issue.diagnostic} />
      </>}
    </details>
  </section>;
}
