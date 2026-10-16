import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RemoteDiagnosticLog, readRemoteDiagnostic, redactRemoteLog } from '../src/services/remoteDiagnostics';
import { log } from '../src/services/logger';

test('redacts credential protocol, keys, bearer headers, URL credentials and private keys', () => {
  const value = redactRemoteLog([
    'MICHI_SETUP_JSON:{"token":"protocol-private"}',
    'MICHI_REMOTE_TOKEN=env-private', 'Authorization: Bearer header-private',
    'https://user:pass@example.com/path', 'api_key: "key-private"',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-body\n-----END OPENSSH PRIVATE KEY-----',
    'npm ERR! build failed',
  ].join('\n'));
  assert.doesNotMatch(value, /protocol-private|env-private|header-private|user:pass|key-private|private-body/);
  assert.match(value, /npm ERR! build failed/);
});

test('persists sanitized stage and actual exception for lookup with private permissions', () => {
  const diagnostic = new RemoteDiagnosticLog('build+');
  const file = path.join(log.logDir(), 'remote-connections', diagnostic.report.id + '.json');
  try {
    diagnostic.protect('private-remote-credential');
    diagnostic.stage('tunnel', 'Opening SSH forwarding');
    diagnostic.fail(new Error('bind failed private-remote-credential', { cause: new Error('EADDRINUSE') }), 'setup_failed');
    diagnostic.finish();
    const report = readRemoteDiagnostic(diagnostic.report.id)!;
    assert.equal(report.stage, 'tunnel');
    assert.equal(report.code, 'setup_failed');
    assert.match(report.log, /EADDRINUSE/);
    assert.doesNotMatch(JSON.stringify(report), /private-remote-credential/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(readRemoteDiagnostic('../backend.log'), null);
    diagnostic.append('large', 'x'.repeat(5 * 1024 * 1024));
    assert.equal(diagnostic.report.truncated, true);
    assert.ok(diagnostic.report.log.length <= 4 * 1024 * 1024);
  } finally { fs.rmSync(file, { force: true }); }
});

test('successful connection warnings retain sanitized logs without calling the connection failed', () => {
  const diagnostic = new RemoteDiagnosticLog('build+');
  try {
    diagnostic.protect('private-runtime-value');
    const warnings = diagnostic.warn(['Sign in: private-runtime-value', 'API_TOKEN=hidden-value']);
    diagnostic.finish();
    const report = readRemoteDiagnostic(diagnostic.report.id)!;
    assert.equal(report.severity, 'warning');
    assert.equal(report.code, 'runtime_warning');
    assert.equal(report.stage, 'runtime');
    assert.match(report.log, /runtime warning/);
    assert.doesNotMatch(JSON.stringify(report) + warnings.join(' '), /private-runtime-value|hidden-value/);
  } finally { fs.rmSync(diagnostic.report.localLogPath!, { force: true }); }
});
