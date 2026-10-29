// Shared scaffolding for the Electron smokes started by
// scripts/run-electron-smoke.mjs: a hidden host window holding one sandboxed
// WebContentsView, a 10 s timeout, and a "<name>: matched|missed" line with a
// matching exit code from the smoke's check.
const { app, BrowserWindow, WebContentsView } = require('electron');

function runSmoke(name, check) {
  const timeout = setTimeout(() => {
    console.error(`${name}: timed out`);
    app.exit(1);
  }, 10_000);

  app.whenReady().then(async () => {
    const host = new BrowserWindow({ show: false });
    const view = new WebContentsView({ webPreferences: { sandbox: true } });
    host.contentView.addChildView(view);
    const passed = (await check({ host, view })) === true;
    clearTimeout(timeout);
    console.log(`${name}: ${passed ? 'matched' : 'missed'}`);
    host.destroy();
    app.exit(passed ? 0 : 1);
  }).catch((error) => {
    clearTimeout(timeout);
    console.error(error);
    app.exit(1);
  });
}

module.exports = { runSmoke };
