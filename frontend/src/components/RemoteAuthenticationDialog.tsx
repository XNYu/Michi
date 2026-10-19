import { lazy, Suspense } from 'react';
import { remoteSignInLabel } from 'michi-shared';
import { closeRemoteAuthentication, requestRemoteAuthentication, usePendingRemoteAuthentications, useRemoteAuthentication } from '../state/remoteAuthentication';
import { ModalShell } from './ui/ModalShell';
import { Button } from './ui/controls';
import './RemoteAuthenticationDialog.css';
const AuthenticationTerminal = lazy(() => import('./RemoteAuthenticationTerminal'));

export function RemoteAuthenticationDialog() {
  const request = useRemoteAuthentication();
  const pending = usePendingRemoteAuthentications();
  if (!request) return <>{pending.map(issue => <div key={issue.key} className="remote-auth-service-notice" role="status">
    <span>{issue.target.host}: sign-in needs attention.</span>
    <Button size="sm" variant="ghost" onClick={() => requestRemoteAuthentication(issue, true)}>{remoteSignInLabel()}</Button>
  </div>)}</>;
  return <ModalShell open onClose={closeRemoteAuthentication} title={remoteSignInLabel()} width={680} maxHeight="85vh" captureEscape>
    <Suspense fallback={<p role="status">Opening authentication terminal…</p>}>
      <AuthenticationTerminal key={request.key} request={request} />
    </Suspense>
  </ModalShell>;
}
