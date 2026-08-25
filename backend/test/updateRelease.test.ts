import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  appBundlePathFromExecPath,
  githubLatestReleaseUrl,
  isAllowedDownloadUrl,
  isNewerVersion,
  parseGithubRelease,
  parseSemver,
  parseUpdateState,
  pickMacDmgAsset,
  resolveCurrentVersion,
  shouldPromptUpdate,
  stripTagPrefix,
} from '../../electron/updateRelease';

describe('stripTagPrefix / parseSemver / isNewerVersion', () => {
  test('strips a leading v', () => {
    assert.equal(stripTagPrefix('v0.3.0'), '0.3.0');
    assert.equal(stripTagPrefix('0.3.0'), '0.3.0');
  });

  test('parses dotted triples and ignores a pre-release suffix', () => {
    assert.deepEqual(parseSemver('v1.2.3-beta'), [1, 2, 3]);
    assert.equal(parseSemver('not-a-version'), null);
  });

  test('detects a newer release', () => {
    assert.equal(isNewerVersion('0.3.0', '0.2.1'), true);
    assert.equal(isNewerVersion('v0.2.1', '0.2.1'), false);
    assert.equal(isNewerVersion('0.2.1', '0.3.0'), false);
    assert.equal(isNewerVersion('1.0.0', '0.9.9'), true);
  });
});

describe('parseGithubRelease / pickMacDmgAsset', () => {
  test('rejects malformed payloads', () => {
    assert.equal(parseGithubRelease(null), null);
    assert.equal(parseGithubRelease({ name: 'nope' }), null);
  });

  test('reads tag, notes, and assets', () => {
    const rel = parseGithubRelease({
      tag_name: 'v0.3.0',
      name: 'v0.3.0',
      body: 'notes',
      prerelease: false,
      draft: false,
      assets: [
        { name: 'michi-0.3.0-arm64.dmg', browser_download_url: 'https://github.com/XNYu/Michi/releases/download/v0.3.0/michi-0.3.0-arm64.dmg' },
        { name: 'notes.txt' },
      ],
    });
    assert.ok(rel);
    assert.equal(rel.tag_name, 'v0.3.0');
    assert.equal(rel.body, 'notes');
    assert.equal(rel.assets.length, 1);
    const dmg = pickMacDmgAsset(rel.assets);
    assert.ok(dmg);
    assert.equal(dmg.name, 'michi-0.3.0-arm64.dmg');
  });

  test('prefers an arm64 dmg when several exist', () => {
    const dmg = pickMacDmgAsset([
      { name: 'michi-x64.dmg', browser_download_url: 'https://example.com/x64.dmg' },
      { name: 'michi-arm64.dmg', browser_download_url: 'https://example.com/arm.dmg' },
    ]);
    assert.equal(dmg?.name, 'michi-arm64.dmg');
  });

  test('returns null when no dmg is attached', () => {
    assert.equal(pickMacDmgAsset([{ name: 'notes.md', browser_download_url: 'https://example.com/n' }]), null);
  });
});

describe('isAllowedDownloadUrl', () => {
  test('allows github download hosts and rejects others', () => {
    assert.equal(isAllowedDownloadUrl('https://github.com/XNYu/Michi/releases/download/v0.3.0/michi.dmg'), true);
    assert.equal(isAllowedDownloadUrl('https://objects.githubusercontent.com/foo'), true);
    assert.equal(isAllowedDownloadUrl('http://github.com/XNYu/Michi/a.dmg'), false);
    assert.equal(isAllowedDownloadUrl('https://evil.example/michi.dmg'), false);
  });
});

describe('resolveCurrentVersion / shouldPromptUpdate', () => {
  test('prefers a baked tag, then persisted, then a real app version', () => {
    assert.deepEqual(
      resolveCurrentVersion({ bakedTag: 'v0.3.0', persistedTag: 'v0.2.1', appVersion: '1.0.0' }),
      { version: '0.3.0', unversioned: false },
    );
    assert.deepEqual(
      resolveCurrentVersion({ bakedTag: null, persistedTag: 'v0.2.1', appVersion: '1.0.0' }),
      { version: '0.2.1', unversioned: false },
    );
    assert.deepEqual(
      resolveCurrentVersion({ bakedTag: null, persistedTag: null, appVersion: '0.4.0' }),
      { version: '0.4.0', unversioned: false },
    );
  });

  test('treats the historical 1.0.0 package version as unversioned', () => {
    assert.deepEqual(
      resolveCurrentVersion({ bakedTag: null, persistedTag: null, appVersion: '1.0.0' }),
      { version: '1.0.0', unversioned: true },
    );
  });

  test('unversioned first check is silent; a later tag prompts', () => {
    assert.equal(shouldPromptUpdate({
      latestTag: 'v0.3.0',
      currentVersion: '1.0.0',
      unversioned: true,
    }), false);
    assert.equal(shouldPromptUpdate({
      latestTag: 'v0.3.0',
      currentVersion: '1.0.0',
      unversioned: true,
      lastSeenTag: 'v0.3.0',
    }), false);
    assert.equal(shouldPromptUpdate({
      latestTag: 'v0.4.0',
      currentVersion: '1.0.0',
      unversioned: true,
      lastSeenTag: 'v0.3.0',
    }), true);
  });

  test('versioned builds prompt when GitHub is ahead', () => {
    assert.equal(shouldPromptUpdate({
      latestTag: 'v0.4.0',
      currentVersion: '0.3.0',
      unversioned: false,
    }), true);
    assert.equal(shouldPromptUpdate({
      latestTag: 'v0.3.0',
      currentVersion: '0.3.0',
      unversioned: false,
    }), false);
  });
});

describe('parseUpdateState / paths / url', () => {
  test('reads known keys and ignores junk', () => {
    assert.deepEqual(parseUpdateState({ installedTag: 'v0.3.0', extra: 1 }), {
      installedTag: 'v0.3.0',
      lastSeenTag: null,
    });
    assert.deepEqual(parseUpdateState('nope'), {});
  });

  test('walks up from Contents/MacOS to the .app bundle', () => {
    assert.equal(
      appBundlePathFromExecPath('/Users/nan/Applications/michi.app/Contents/MacOS/michi'),
      '/Users/nan/Applications/michi.app',
    );
    assert.equal(appBundlePathFromExecPath('/usr/local/bin/electron'), null);
  });

  test('builds the public latest-release API url', () => {
    assert.equal(
      githubLatestReleaseUrl(),
      'https://api.github.com/repos/XNYu/Michi/releases/latest',
    );
  });
});
