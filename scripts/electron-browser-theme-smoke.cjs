// Checks that applyBrowserTheme switches a sandboxed view's
// prefers-color-scheme. Runs from `npm run test:electron-browser`, or alone
// with `node scripts/run-electron-smoke.mjs browser-theme` after
// `npm run electron:build-main`; it needs a desktop session.
const { applyBrowserTheme, normalizeBrowserTheme } = require('../electron/dist/browserTheme.js');
const { runSmoke } = require('./electron-smoke-harness.cjs');

runSmoke('native-browser-theme-smoke', async ({ view }) => {
  await view.webContents.loadURL('about:blank');
  await applyBrowserTheme(view, normalizeBrowserTheme(true, '#272822'));
  await view.webContents.loadURL('data:text/html,<title>theme smoke</title>');
  const darkMatched = await view.webContents.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches");

  await applyBrowserTheme(view, normalizeBrowserTheme(false, '#fdfdfc'));
  const lightMatched = await view.webContents.executeJavaScript("matchMedia('(prefers-color-scheme: light)').matches");

  return darkMatched === true && lightMatched === true;
});
