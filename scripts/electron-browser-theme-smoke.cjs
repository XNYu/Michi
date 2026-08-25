const { app, BrowserWindow, WebContentsView } = require('electron');
const { applyBrowserTheme, normalizeBrowserTheme } = require('../electron/dist/browserTheme.js');

const timeout = setTimeout(() => {
  console.error('native-browser-theme-smoke: timed out');
  app.exit(1);
}, 10_000);

app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: false });
  const view = new WebContentsView({ webPreferences: { sandbox: true } });
  host.contentView.addChildView(view);

  await view.webContents.loadURL('about:blank');
  await applyBrowserTheme(view, normalizeBrowserTheme(true, '#272822'));
  await view.webContents.loadURL('data:text/html,<title>theme smoke</title>');
  const darkMatched = await view.webContents.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches");

  await applyBrowserTheme(view, normalizeBrowserTheme(false, '#fdfdfc'));
  const lightMatched = await view.webContents.executeJavaScript("matchMedia('(prefers-color-scheme: light)').matches");

  clearTimeout(timeout);
  const passed = darkMatched === true && lightMatched === true;
  console.log(`native-browser-theme-smoke: ${passed ? 'matched' : 'missed'}`);
  host.destroy();
  app.exit(passed ? 0 : 1);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
