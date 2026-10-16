export interface RemoteConnectionDiagnostic {
  id: string;
  host: string;
  startedAt: string;
  stage: string;
  code?: string;
  message?: string;
  log: string;
  truncated: boolean;
  storageError?: string;
  localLogPath?: string;
}

export function formatRemoteDiagnostic(report: RemoteConnectionDiagnostic): string {
  return [
    'Michi remote connection diagnostic',
    'Attempt: ' + report.id,
    'Host: ' + report.host,
    'Started: ' + report.startedAt,
    'Stage: ' + report.stage,
    report.localLogPath ? 'Saved log: ' + report.localLogPath : '',
    'Error: ' + (report.code ?? 'unknown') + ': ' + (report.message ?? 'Connection interrupted'),
    report.truncated ? 'Capture limit reached. Some output was omitted; see the report for available remote log paths.' : '',
    report.storageError ?? '',
    '', report.log,
  ].filter(line => line !== '').join('\n');
}
