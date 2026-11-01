import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../electron/windowsLifecycle.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function loadLifecycle() {
  const exports = {};
  vm.runInNewContext(compiled, { exports, module: { exports }, require() { throw new Error('windowsLifecycle must stay Electron-free'); } }, {
    filename: 'electron/windowsLifecycle.ts',
  });
  return exports;
}

function packagedWindows(overrides = {}) {
  return { platform: 'win32', isPackaged: true, isDev: false, ...overrides };
}

function fakeAdapters(initial = {}) {
  const prefs = { keepInBackground: false, openAtLogin: false, ...(initial.prefs ?? {}) };
  const calls = [];
  const windows = (initial.windows ?? [
    { id: 1, webContentsId: 10, visible: true, minimized: false, destroyed: false },
  ]).map((window) => ({ ...window }));
  let trayOk = initial.trayOk !== false;
  let login = { openAtLogin: false, path: '', args: [] };
  return {
    calls,
    windows,
    prefs,
    set trayOk(value) { trayOk = value; },
    adapters: {
      readPreferences: () => ({ ...prefs, token: initial.leakedSecret }),
      writePreferences: (next) => {
        Object.assign(prefs, next);
        calls.push(['writePreferences', { ...next }]);
      },
      fileExists: (candidate) => candidate.includes('Update.exe') && !!initial.squirrel,
      execPath: initial.execPath ?? 'C:\\Program Files\\Michi\\Michi.exe',
      createTray: () => {
        calls.push(['createTray']);
        return trayOk;
      },
      destroyTray: () => { calls.push(['destroyTray']); },
      hideWindow: (id) => {
        calls.push(['hideWindow', id]);
        const window = windows.find((item) => item.id === id);
        if (window) window.visible = false;
      },
      restoreWindow: (id) => {
        calls.push(['restoreWindow', id]);
        const window = windows.find((item) => item.id === id);
        if (window) {
          window.visible = true;
          window.minimized = false;
        }
      },
      focusWindow: (id) => { calls.push(['focusWindow', id]); },
      listWindows: () => windows.filter((window) => !window.destroyed).map((window) => ({ ...window })),
      quit: () => { calls.push(['quit']); },
      stopBackend: () => { calls.push(['stopBackend']); },
      setLoginItem: (settings) => {
        calls.push(['setLoginItem', settings]);
        if (initial.loginFail) {
          if (initial.loginFail === 'throw') throw new Error('registry denied');
          return false;
        }
        login = { ...login, ...settings, enabled: settings.openAtLogin !== false };
        return true;
      },
      getLoginItem: () => ({
        openAtLogin: login.openAtLogin,
        executableWillLaunchAtLogin: login.executableWillLaunchAtLogin ?? login.openAtLogin,
        enabled: login.enabled ?? login.openAtLogin,
      }),
    },
  };
}

function same(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test('defaults preserve quit-on-last-window and never persist leftover keys', () => {
  const { parseLifetimePreferences, serializeLifetimePreferences, HIDDEN_LAUNCH_ARG, TRAY_MENU } = loadLifecycle();
  same(parseLifetimePreferences(undefined), { keepInBackground: false, openAtLogin: false });
  same(parseLifetimePreferences({ keepInBackground: true, openAtLogin: true, token: 'secret' }), {
    keepInBackground: true, openAtLogin: true,
  });
  same(serializeLifetimePreferences({ keepInBackground: true, openAtLogin: false, token: 'secret' }), {
    keepInBackground: true, openAtLogin: false,
  });
  assert.equal(HIDDEN_LAUNCH_ARG, '--michi-hidden');
  same(TRAY_MENU.map((item) => item.label), ['Show Michi', 'Quit']);
});

test('owned-window sender rejects embedded browser views and non-main frames', () => {
  const { isOwnedWindowSender, isOwnedLifetimeSender } = loadLifecycle();
  assert.equal(isOwnedWindowSender(10, [10, 11]), true);
  assert.equal(isOwnedWindowSender(99, [10, 11]), false);
  assert.equal(isOwnedWindowSender(10, []), false);
  assert.equal(isOwnedLifetimeSender({ senderId: 10, windowWebContentsIds: [10], senderFrameIsMainFrame: true }), true);
  assert.equal(isOwnedLifetimeSender({ senderId: 10, windowWebContentsIds: [10], senderFrameIsMainFrame: false }), false);
  assert.equal(isOwnedLifetimeSender({ senderId: 99, windowWebContentsIds: [10], senderFrameIsMainFrame: true }), false);
});

test('closing the last window hides to tray when opted in and the tray works', () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const fake = fakeAdapters({ prefs: { keepInBackground: true } });
  const controller = new WindowsLifetimeController(packagedWindows(), fake.adapters);
  assert.equal(controller.onAppReady({ launchedHidden: false }).createWindow, true);
  assert.equal(controller.handleWindowClose(1), 'hide');
  assert.deepEqual(fake.calls.filter(([name]) => name === 'hideWindow'), [['hideWindow', 1]]);
  assert.equal(fake.calls.some(([name]) => name === 'quit' || name === 'stopBackend'), false);
  assert.equal(controller.shouldQuitWhenNoWindows(), false);
});

test('closing the last window quits unless the user opted into a working tray', () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const defaulted = fakeAdapters();
  const controller = new WindowsLifetimeController(packagedWindows(), defaulted.adapters);
  controller.onAppReady({ launchedHidden: false });
  assert.equal(controller.handleWindowClose(1), 'allow-close');
  assert.equal(controller.shouldQuitWhenNoWindows(), true);

  const failed = fakeAdapters({ prefs: { keepInBackground: true }, trayOk: false });
  const broken = new WindowsLifetimeController(packagedWindows(), failed.adapters);
  const ready = broken.onAppReady({ launchedHidden: false });
  assert.equal(ready.createWindow, true);
  assert.equal(ready.trayActive, false);
  assert.equal(broken.handleWindowClose(1), 'allow-close');
  assert.equal(broken.shouldQuitWhenNoWindows(), true);
  assert.equal(broken.status().keepInBackground, true);
  assert.equal(broken.status().trayActive, false);
  assert.equal(broken.status().canStartHidden, false);
});

test('explicit quit, updater, and shutdown stop the backend and do not hide', async () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const fake = fakeAdapters({ prefs: { keepInBackground: true } });
  const controller = new WindowsLifetimeController(packagedWindows(), fake.adapters);
  controller.onAppReady({ launchedHidden: false });
  for (const reason of ['user', 'updater', 'shutdown']) {
    fake.calls.length = 0;
    controller.beginQuit(reason);
    assert.equal(controller.handleWindowClose(1), 'quit-close');
    assert.equal(controller.shouldQuitWhenNoWindows(), true);
    await controller.finalizeQuit();
    assert.deepEqual(fake.calls.map(([name]) => name), ['destroyTray', 'stopBackend']);
  }
});

test('second instance restores a hidden or minimized window instead of spawning another', () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const hidden = fakeAdapters({
    prefs: { keepInBackground: true },
    windows: [{ id: 4, webContentsId: 40, visible: false, minimized: false, destroyed: false }],
  });
  const controller = new WindowsLifetimeController(packagedWindows(), hidden.adapters);
  controller.onAppReady({ launchedHidden: false });
  same(controller.handleSecondInstance(['Michi.exe']), { action: 'restore', windowId: 4 });
  assert.deepEqual(hidden.calls.filter(([name]) => name === 'restoreWindow' || name === 'focusWindow'), [
    ['restoreWindow', 4],
    ['focusWindow', 4],
  ]);

  const minimized = fakeAdapters({
    windows: [{ id: 5, webContentsId: 50, visible: true, minimized: true, destroyed: false }],
  });
  const restore = new WindowsLifetimeController(packagedWindows(), minimized.adapters);
  same(restore.handleSecondInstance(['Michi.exe']), { action: 'restore', windowId: 5 });

  const empty = fakeAdapters({ windows: [] });
  const create = new WindowsLifetimeController(packagedWindows(), empty.adapters);
  same(create.handleSecondInstance(['Michi.exe']), { action: 'create-window' });
  same(create.handleSecondInstance(['Michi.exe', '--michi-background-launch']), { action: 'ignore' });
});

test('login startup is packaged Windows only and uses the real executable plus hidden args only with a working tray', () => {
  const { WindowsLifetimeController, HIDDEN_LAUNCH_ARG, loginItemLaunchPath } = loadLifecycle();
  assert.equal(
    loginItemLaunchPath('C:\\Users\\me\\AppData\\Local\\michi\\app-1.2.3\\Michi.exe', (candidate) => candidate.endsWith('Update.exe')),
    'C:\\Users\\me\\AppData\\Local\\michi\\Michi.exe',
  );
  assert.equal(
    loginItemLaunchPath('C:\\Program Files\\Michi\\Michi.exe', () => false),
    'C:\\Program Files\\Michi\\Michi.exe',
  );

  const fake = fakeAdapters({ prefs: { keepInBackground: true } });
  const controller = new WindowsLifetimeController(packagedWindows(), fake.adapters);
  controller.onAppReady({ launchedHidden: false });
  assert.equal(fake.calls.some(([name]) => name === 'setLoginItem'), false);
  controller.setOpenAtLogin(true);
  const login = fake.calls.filter(([name]) => name === 'setLoginItem').at(-1)[1];
  assert.equal(login.openAtLogin, true);
  assert.equal(login.path, 'C:\\Program Files\\Michi\\Michi.exe');
  same(login.args, [HIDDEN_LAUNCH_ARG]);
  same(fake.calls.find(([name]) => name === 'writePreferences')[1], {
    keepInBackground: true, openAtLogin: true,
  });

  const failed = fakeAdapters({ prefs: { keepInBackground: true }, trayOk: false });
  const visible = new WindowsLifetimeController(packagedWindows(), failed.adapters);
  visible.onAppReady({ launchedHidden: false });
  visible.setOpenAtLogin(true);
  same(failed.calls.filter(([name]) => name === 'setLoginItem').at(-1)[1].args, []);

  for (const env of [
    { platform: 'darwin', isPackaged: true, isDev: false },
    { platform: 'win32', isPackaged: false, isDev: false },
    { platform: 'win32', isPackaged: true, isDev: true },
  ]) {
    const blocked = fakeAdapters();
    const other = new WindowsLifetimeController(env, blocked.adapters);
    assert.equal(other.status().supported, false);
    assert.equal(other.status().keepInBackground, false);
    assert.equal(other.status().openAtLogin, false);
    assert.throws(() => other.setOpenAtLogin(true), /installed Windows app|available on Windows/);
    assert.equal(blocked.calls.some(([name]) => name === 'setLoginItem'), false);
  }
});

test('hidden login start still creates a real window and shows it if the tray fails', () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const ok = fakeAdapters({ prefs: { keepInBackground: true, openAtLogin: true } });
  const hidden = new WindowsLifetimeController(packagedWindows(), ok.adapters);
  same(hidden.onAppReady({ launchedHidden: true }), { createWindow: true, trayActive: true, startHidden: true });
  assert.equal(ok.calls.some(([name]) => name === 'setLoginItem'), false);

  const failed = fakeAdapters({ prefs: { keepInBackground: true, openAtLogin: true }, trayOk: false });
  const stranded = new WindowsLifetimeController(packagedWindows(), failed.adapters);
  same(stranded.onAppReady({ launchedHidden: true }), { createWindow: true, trayActive: false, startHidden: false });
});

test('ordinary launch never writes login items and reflects a Windows-disabled entry as off', () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const fake = fakeAdapters({ prefs: { keepInBackground: true, openAtLogin: true } });
  fake.adapters.getLoginItem = () => ({
    openAtLogin: true,
    executableWillLaunchAtLogin: false,
    enabled: false,
  });
  const controller = new WindowsLifetimeController(packagedWindows(), fake.adapters);
  controller.onAppReady({ launchedHidden: false });
  assert.equal(fake.calls.some(([name]) => name === 'setLoginItem'), false);
  assert.equal(controller.status().openAtLogin, false);
  assert.equal(controller.status().keepInBackground, true);
});

test('macOS quit still uses allow-close so the visible terminal prompt stays', () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const fake = fakeAdapters();
  const controller = new WindowsLifetimeController({ platform: 'darwin', isPackaged: true, isDev: false }, fake.adapters);
  controller.beginQuit('user');
  assert.equal(controller.handleWindowClose(1), 'allow-close');
});

test('keep-in-background login arg refresh surfaces failure without reverting the preference', () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const fake = fakeAdapters({ loginFail: true });
  fake.adapters.getLoginItem = () => ({
    openAtLogin: true,
    executableWillLaunchAtLogin: true,
    enabled: true,
  });
  const controller = new WindowsLifetimeController(packagedWindows(), fake.adapters);
  controller.onAppReady({ launchedHidden: false });
  assert.equal(fake.calls.some(([name]) => name === 'setLoginItem'), false);
  assert.throws(() => controller.setKeepInBackground(true), /update sign-in|could not update/i);
  assert.equal(controller.status().keepInBackground, true);
  assert.equal(fake.prefs.keepInBackground, true);
});

test('failed login registration does not persist or report success', () => {
  const { WindowsLifetimeController } = loadLifecycle();
  const fake = fakeAdapters({ prefs: { keepInBackground: true }, loginFail: true });
  const controller = new WindowsLifetimeController(packagedWindows(), fake.adapters);
  controller.onAppReady({ launchedHidden: false });
  assert.throws(() => controller.setOpenAtLogin(true), /could not enable|sign-in|login/i);
  assert.equal(controller.status().openAtLogin, false);
  assert.equal(fake.calls.some(([name, prefs]) => name === 'writePreferences' && prefs.openAtLogin === true), false);
});
