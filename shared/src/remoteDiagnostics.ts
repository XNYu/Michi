export interface RemoteConnectionDiagnostic {
  id: string;
  host: string;
  startedAt: string;
  stage: string;
  severity?: 'error' | 'warning' | 'info';
  code?: string;
  message?: string;
  log: string;
  truncated: boolean;
  storageError?: string;
  localLogPath?: string;
  authentication?: RemoteAuthenticationTarget;
}

export interface RemoteAuthenticationTarget {
  host: string;
  user?: string;
  port?: number;
  scope: 'local' | 'remote';
}

export interface RemoteServiceRecoveryStatus {
  connectionId: string;
  phase: 'starting' | 'ready' | 'error';
  message: string;
  diagnostic?: RemoteConnectionDiagnostic;
  authentication?: RemoteAuthenticationTarget;
}

export function formatRemoteDiagnostic(report: RemoteConnectionDiagnostic): string {
  return [
    'Michi remote connection diagnostic',
    'Attempt: ' + report.id,
    'Host: ' + report.host,
    'Started: ' + report.startedAt,
    'Stage: ' + report.stage,
    report.localLogPath ? 'Saved log: ' + report.localLogPath : '',
    report.severity === 'info'
      ? 'Status: ' + (report.message ?? 'Connection in progress')
      : (report.severity === 'warning' ? 'Warning: ' : 'Error: ') + (report.code ?? 'unknown') + ': ' + (report.message ?? 'Connection interrupted'),
    report.truncated ? report.stage === 'workspace'
      ? 'Recovery history limit reached. Only the most recent client-side attempts are included.'
      : 'Capture limit reached. Some output was omitted; see the report for available remote log paths.' : '',
    report.storageError ?? '',
    '', report.log,
  ].filter(line => line !== '').join('\n');
}

// Apply before persistence, display, copying or sending to an agent. Protocol
// records are private even when they do not happen to contain a credential.
export function redactRemoteLog(value: string): string {
  return value
    .replace(/^.*MICHI_SETUP_JSON:.*$/gm, '[private setup response omitted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key omitted]')
    .replace(/\b(Bearer\s+)[^\s"'<>]+/gi, '$1[redacted]')
    .replace(/((?:\b[\w-]{0,96}(?:token|password|secret|api[_-]?key)[\w-]{0,96})["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b/g, '[redacted]')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
