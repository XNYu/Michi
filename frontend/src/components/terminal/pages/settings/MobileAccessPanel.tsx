import { useEffect, useId, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { MobileAccessLink, MobileAccessStatus } from 'michi-shared';
import { Button } from '../../../ui/controls';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { createMobileAccessLink, mobileAccessRequest, type MobileAccessAction } from '../../../../services/api/mobileAccess';
import { openExternalUrl } from '../../../../services/openUrl';
import { LOCAL_BACKEND_CONNECTION_ID, type BackendConnectionSummary } from '../../../../config/backendConnections';
import { SettingsRow, SettingsSection } from './SettingsSection';
import './mobileAccess.css';

/** True when this page itself was opened through the phone access address. */
function servedThrough(url: string | undefined): boolean {
  if (!url) return false;
  try { return new URL(url).origin === window.location.origin; } catch { return false; }
}

export function MobileAccessPanel({ connections }: { connections: BackendConnectionSummary[] }) {
  const machineId = useId();
  const [machine, setMachine] = useState('local');
  const [status, setStatus] = useState<MobileAccessStatus | null>(null);
  const [link, setLink] = useState<MobileAccessLink | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const mutation = useRef(0);
  const acting = useRef(false);
  useEffect(() => {
    const revision = ++generation.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setStatus(null); setLink(null); setError(''); setBusy(false); setCopied(false); acting.current = false;
    const refresh = async () => {
      const version = mutation.current;
      try {
        if (acting.current) { timer = setTimeout(refresh, 3000); return; }
        const next = await mobileAccessRequest(machine, undefined, controller.signal);
        if (generation.current !== revision) return;
        if (version !== mutation.current || acting.current) { timer = setTimeout(refresh, 3000); return; }
        setStatus(next); setError('');
        if (next.state !== 'connected') setLink(null);
      } catch (err) { if (!controller.signal.aborted && generation.current === revision && version === mutation.current && !acting.current) setError((err as Error).message); }
      if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { ++generation.current; controller.abort(); clearTimeout(timer); };
  }, [machine]);
  useEffect(() => {
    if (machine !== 'local' && !connections.some(c => c.id === machine)) setMachine('local');
  }, [connections, machine]);
  useEffect(() => {
    if (!link || link.reusable) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [link]);
  useEffect(() => {
    if (status?.provider !== 'tailscale' || status.state !== 'connected') return;
    let cancelled = false;
    const revision = generation.current;
    const version = mutation.current;
    void createMobileAccessLink(machine).then(next => {
      if (!cancelled && revision === generation.current && version === mutation.current) { setLink(next); setNow(Date.now()); }
    }, err => { if (!cancelled && revision === generation.current && version === mutation.current) setError((err as Error).message); });
    return () => { cancelled = true; };
  }, [machine, status?.provider, status?.state, status?.url]);
  const activeLink = link && (link.reusable || link.expiresAt > now) ? link : null;
  const qr = useMemo(() => {
    if (!activeLink) return null;
    const code = qrcode(0, 'M'); code.addData(activeLink.url); code.make();
    return code;
  }, [activeLink]);
  const act = async (action: MobileAccessAction) => {
    if (acting.current) return;
    // Turning it off from a device connected through it ends that device's session.
    if (action === 'stop' && machine === LOCAL_BACKEND_CONNECTION_ID && servedThrough(status?.url) && !(await confirmDialog({
      title: 'Turn off phone access?',
      message: 'This page is open through phone access, so turning it off ends this session. Turn it on again from Michi on this machine.',
      confirmLabel: 'Turn off',
    }))) return;
    if (acting.current) return;
    const revision = generation.current;
    ++mutation.current; acting.current = true;
    setBusy(true); setError(''); setCopied(false);
    try {
      if (action === 'link') {
        const next = await createMobileAccessLink(machine);
        if (generation.current === revision) { setLink(next); setNow(Date.now()); }
      } else {
        const next = await mobileAccessRequest(machine, action);
        if (generation.current === revision) { setStatus(next); setLink(null); }
      }
    } catch (err) { if (generation.current === revision) setError((err as Error).message); }
    finally { if (generation.current === revision) { acting.current = false; setBusy(false); } }
  };
  const running = status && ['starting', 'connected', 'reconnecting'].includes(status.state);
  const tailscale = status?.provider === 'tailscale';
  const setup = status?.tailscale;
  const ready = !tailscale || setup?.state === 'ready';
  return <SettingsSection className="mobile-access" title="Phone access"
    aside={status && <span role="status">{{ stopped: 'Off', starting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', error: 'Unavailable' }[status.state]}</span>}
    intro="Open this machine’s Michi on your phone through your private Tailscale network.">
    <SettingsRow label="Machine" labelFor={machineId} control={
      <select id={machineId} className="ui-select settings-row__select" value={machine} onChange={event => setMachine(event.target.value)}>
        <option value="local">This machine</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>} />
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    {tailscale && <div className="mobile-access__setup">
      <ol>
        <li><strong>Connect this machine.</strong> {setup?.account ? <>Signed in as {setup.account}.</> : setup?.message || 'Checking Tailscale…'}</li>
        <li><strong>Connect your phone.</strong> Install Tailscale on your phone, sign in with the same account and allow its VPN connection. <button type="button" className="mobile-access__text-link" onClick={() => openExternalUrl('https://tailscale.com/download')}>Get Tailscale</button></li>
        <li><strong>Open Michi.</strong> Scan the code below inside Michi on your iPhone to connect the app. Your phone’s Camera app opens the web version, which you can bookmark or add to your home screen.</li>
      </ol>
      {setup?.state === 'not-installed' && <Button onClick={() => openExternalUrl('https://tailscale.com/download')}>Install Tailscale on this machine</Button>}
      {setup?.state === 'not-running' && setup.canOpenApp && <Button disabled={busy} onClick={() => void act('open-app')}>Open Tailscale</Button>}
      {setup?.state === 'needs-login' && <Button disabled={busy} onClick={() => void act('login')}>Connect Tailscale</Button>}
      {setup?.state === 'needs-approval' && !setup.actionUrl && <Button onClick={() => openExternalUrl('https://login.tailscale.com/admin/machines')}>Approve this machine</Button>}
      {setup?.actionUrl && <Button onClick={() => openExternalUrl(setup.actionUrl!)}>{setup.state === 'needs-login' ? 'Continue Tailscale sign-in' : 'Allow Tailscale HTTPS'}</Button>}
      {setup?.state === 'not-running' && !setup.canOpenApp && <p>Start the Tailscale app or service on this computer, then connect it to your account.</p>}
    </div>}
    <div className="mobile-access__actions">
      <Button disabled={busy || !status || (!running && (!status.available || !ready))} variant={running ? 'secondary' : 'primary'} onClick={() => void act(running ? 'stop' : 'start')}>{running ? 'Turn off' : 'Enable phone access'}</Button>
      {status?.state === 'connected' && !activeLink?.reusable && <Button disabled={busy} onClick={() => void act('link')}>{activeLink ? 'New sign-in link' : 'Connect phone'}</Button>}
    </div>
    {activeLink && qr && <div className="mobile-access__link">
      <svg role="img" aria-label="Scan to connect to Michi" viewBox={`-4 -4 ${qr.getModuleCount() + 8} ${qr.getModuleCount() + 8}`} width="192" height="192" shapeRendering="crispEdges">
        <rect x="-4" y="-4" width={qr.getModuleCount() + 8} height={qr.getModuleCount() + 8} fill="white" />
        <path fill="black" d={Array.from({ length: qr.getModuleCount() }, (_, r) => Array.from({ length: qr.getModuleCount() }, (_, c) => qr.isDark(r, c) ? `M${c} ${r}h1v1h-1z` : '').join('')).join('')} />
      </svg>
      <div><p>Keep Tailscale connected on your phone, then scan inside Michi or with your phone’s Camera app.</p><p>{activeLink.reusable ? 'Reuse or bookmark this link while phone access is enabled.' : <>One use · expires in {Math.max(1, Math.ceil((activeLink.expiresAt - now) / 60_000))} min</>}</p>
        <Button onClick={() => { const revision = generation.current; void Promise.resolve().then(() => navigator.clipboard.writeText(activeLink.url)).then(() => { if (revision === generation.current) setCopied(true); }, () => { if (revision === generation.current) setError('Could not copy. Scan the code to connect.'); }); }}>{copied ? 'Copied' : activeLink.reusable ? 'Copy phone link' : 'Copy sign-in link'}</Button>
      </div>
    </div>}
    {link && !activeLink && <p>The sign-in link expired. Create a new one to connect.</p>}
    {status?.url && <a className="mobile-access__url" href={status.url} target="_blank" rel="noreferrer">{status.url}</a>}
    {tailscale && status?.state === 'connected' && <p>On iPhone, enable VPN On Demand in Tailscale to reconnect automatically. Another VPN may interrupt the connection. This machine must stay awake with Michi running.</p>}
  </SettingsSection>;
}
