import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { REMOTE_CREDENTIALS, remoteSignInCommand } from 'michi-shared';
import { getElectron } from '../lib/electronBridge';
import { usePrefs } from '../state/prefs';
import { terminalTheme } from './terminal/terminalTheme';
import { closeRemoteAuthentication, completeRemoteAuthentication, type RemoteAuthenticationRequest } from '../state/remoteAuthentication';
import { recoverRemoteService } from '../services/api/remoteRecovery';
import { retryRemoteWorkspace } from '../state/remoteRecovery';
import { Button } from './ui/controls';
import './RemoteAuthenticationDialog.css';

export default function AuthenticationTerminal({ request }: { request: RemoteAuthenticationRequest }) {
  const { prefs } = usePrefs();
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState('');
  const [failed, setFailed] = useState(false);
  const [finished, setFinished] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const requestRef = useRef(request);
  const fallbackController = useRef<AbortController | null>(null);
  const native = !!getElectron()?.remoteAuthCreate;
  const command = remoteSignInCommand(request.target);
  const remoteCommand = REMOTE_CREDENTIALS.remoteCommand?.join(' ');

  useEffect(() => () => { fallbackController.current?.abort(); }, []);
  const reconnect = async () => {
    if (reconnecting) return;
    const controller = new AbortController(); fallbackController.current = controller;
    setReconnecting(true);
    try {
      if (request.connectionId) await recoverRemoteService(request.connectionId, controller.signal);
      if (controller.signal.aborted) return;
      if (request.connectionId) retryRemoteWorkspace(request.connectionId);
      request.onComplete?.(); completeRemoteAuthentication(request.key); closeRemoteAuthentication();
    } catch (error) { if (!controller.signal.aborted) setStatus(String(error)); }
    finally { if (!controller.signal.aborted) setReconnecting(false); }
  };

  useEffect(() => {
    const element = host.current;
    const electron = getElectron();
    if (!element || !electron?.remoteAuthCreate) return;
    let disposed = false, completed = false;
    const surface = 'remote-auth-' + crypto.randomUUID();
    const controller = new AbortController();
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, SFMono-Regular, monospace',
      // eslint-disable-next-line no-restricted-syntax -- xterm requires numeric pixel sizes
      fontSize: 13, scrollback: 500, minimumContrastRatio: 4.5 });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(element);
    const resize = () => { if (disposed) return; try { fit.fit(); electron.terminalResize?.(surface, terminal.cols, terminal.rows); } catch { /* closing */ } };
    const observer = new ResizeObserver(resize); observer.observe(element);
    const input = terminal.onData(data => electron.terminalWrite?.(surface, data));
    const offData = electron.onTerminalData?.((id, data) => { if (id === surface && !disposed) terminal.write(data); });
    const offExit = electron.onTerminalExit?.((id, code) => {
      if (id !== surface || disposed || completed) return;
      completed = true;
      electron.terminalDestroy?.(surface);
      if (code !== 0) { setFailed(true); setStatus(`Sign-in exited with code ${code}. You can try again.`); return; }
      setStatus('Sign-in command completed. Reconnecting…');
      const current = requestRef.current;
      void (async () => {
        try {
          if (current.connectionId) {
            await recoverRemoteService(current.connectionId, controller.signal);
            if (!disposed) retryRemoteWorkspace(current.connectionId);
          }
          if (disposed) return;
          current.onComplete?.();
          completeRemoteAuthentication(current.key);
          setFinished(true); setStatus('Sign-in command completed. Michi is checking the connection; retry your chat when ready.');
        } catch (error) { if (!disposed) { setFailed(true); setStatus(error instanceof Error ? error.message : String(error)); } }
      })();
    });
    resize(); setFailed(false); setFinished(false); setStatus('Complete the sign-in prompts below.');
    // React StrictMode replays effects in development. Defer the process spawn
    // so the discarded effect never launches a second authentication command.
    const startTimer = window.setTimeout(() => {
      void electron.remoteAuthCreate!(surface, requestRef.current.target, terminal.cols, terminal.rows).then(snapshot => {
        if (disposed) { electron.terminalDestroy?.(surface); return; }
        if (snapshot.data) terminal.write(snapshot.data);
        terminal.focus();
      }).catch(error => { if (!disposed) { setFailed(true); setStatus(error instanceof Error ? error.message : String(error)); } });
    }, 0);
    return () => {
      disposed = true; window.clearTimeout(startTimer); controller.abort(); observer.disconnect(); input.dispose(); offData?.(); offExit?.();
      electron.terminalDestroy?.(surface); terminal.dispose(); terminalRef.current = null;
    };
  }, [generation]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(prefs.terminalPalette, prefs.terminalAccentOverrides);
  }, [prefs.terminalPalette, prefs.terminalAccentOverrides, generation]);

  return <div className="remote-auth">
    <p>{request.target.scope === 'local'
      ? `SSH sign-in for ${request.target.host} needs attention. ${REMOTE_CREDENTIALS.localAction}, then Michi will check SSH again. If it still fails, check the SSH key and host settings.`
      : remoteCommand
        ? `${REMOTE_CREDENTIALS.name} credentials on ${request.target.host} need attention. This terminal runs ${remoteCommand} on that remote machine.`
        : `Credentials on ${request.target.host} need attention. Sign in on that machine, then reconnect.`}</p>
    {native ? <>
      <p>Enter credentials directly in the terminal and complete any security-key or browser prompts. Closing this window stops sign-in.</p>
      <div ref={host} className="remote-auth__terminal" aria-label="Sign-in terminal" />
      <p role="status">{status}</p>
      <div className="remote-auth__actions">{failed && <Button onClick={() => setGeneration(value => value + 1)}>Try sign-in again</Button>}
        <Button variant="secondary" onClick={closeRemoteAuthentication}>{finished ? 'Done' : 'Cancel'}</Button></div>
    </> : <>
      {command && <><p>Use the Michi desktop app for the embedded terminal, or run this command in Terminal:</p>
      <pre>{command}</pre></>}
      <div className="remote-auth__actions">{command && <Button onClick={() => { void navigator.clipboard.writeText(command).then(() => setCopied(true)).catch(() => setStatus('Select the command above to copy it.')); }}>{copied ? 'Copied' : 'Copy command'}</Button>}
        <Button variant="secondary" disabled={reconnecting} onClick={() => { void reconnect(); }}>{reconnecting ? 'Reconnecting…' : 'I signed in — reconnect'}</Button></div>
      <p role="status">{status}</p>
    </>}
  </div>;
}
