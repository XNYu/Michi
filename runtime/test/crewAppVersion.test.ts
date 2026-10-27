import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CREW_APP_VERSION } from '../src/adapters/crew/crewAppVersion';

test('CREW_APP_VERSION is the version of crew-app/app.json', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../crew-app/app.json'), 'utf8'));
  assert.equal(CREW_APP_VERSION, manifest.version,
    'bump CREW_APP_VERSION in runtime/src/adapters/crew/crewAppVersion.ts together with crew-app/app.json');
});
