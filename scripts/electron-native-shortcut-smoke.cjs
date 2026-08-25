const { app, BrowserWindow, WebContentsView } = require('electron');
const { isClosePaneShortcut } = require('../electron/dist/paneShortcuts.js');

const timeout = setTimeout(() => {
  console.error('native-shortcut-smoke: timed out');
  app.exit(1);
}, 10_000);

app.whenReady().then(async () => {
  const host = new BrowserWindow({ show: false });
  const view = new WebContentsView({ webPreferences: { sandbox: true } });
  host.contentView.addChildView(view);
  let matched = false;
  view.webContents.on('before-input-event', (event, input) => {
    if (!isClosePaneShortcut(input, 'darwin')) return;
    event.preventDefault();
    matched = true;
  });
  await view.webContents.loadURL('data:text/html,<title>shortcut smoke</title>');
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
  setTimeout(() => {
    clearTimeout(timeout);
    console.log(`native-shortcut-smoke: ${matched ? 'matched' : 'missed'}`);
    host.destroy();
    app.exit(matched ? 0 : 1);
  }, 100);
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  app.exit(1);
});
