// Checks that Cmd+W reaches a sandboxed view as the close-pane shortcut.
// Runs from `npm run test:electron-shortcuts`; it needs a desktop session.
const { isClosePaneShortcut } = require('../electron/dist/paneShortcuts.js');
const { runSmoke } = require('./electron-smoke-harness.cjs');

runSmoke('native-shortcut-smoke', async ({ view }) => {
  let matched = false;
  view.webContents.on('before-input-event', (event, input) => {
    if (!isClosePaneShortcut(input, 'darwin')) return;
    event.preventDefault();
    matched = true;
  });
  await view.webContents.loadURL('data:text/html,<title>shortcut smoke</title>');
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  return matched;
});
