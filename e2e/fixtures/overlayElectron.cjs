// Test-only desktop host: the production capture bounds/resize path, native
// vibrancy and presentation flags, without the real backend or user profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { backdropCaptureBounds, backdropImageWidth } = require('../../electron/dist/backdropCapture.js');
const { michiDisabledFeatures } = require('../../electron/dist/chromiumFeatures.js');

app.setPath('userData', process.env.MICHI_OVERLAY_PROFILE);
app.setName('Michi overlay test');
app.commandLine.appendSwitch('disable-features', michiDisabledFeatures(process.platform, process.env).join(','));
let mode = process.env.MICHI_OVERLAY_CAPTURE_MODE || 'success';
const captureMetrics = [];
ipcMain.handle('overlay:metrics', () => captureMetrics.splice(0));
ipcMain.handle('overlay:environment', (event) => ({
  versions: process.versions,
  windowBounds: BrowserWindow.fromWebContents(event.sender).getBounds(),
  displays: require('electron').screen.getAllDisplays().map(({ bounds, scaleFactor, displayFrequency }) => ({ bounds, scaleFactor, displayFrequency })),
  processes: app.getAppMetrics().map(({ type, memory, cpu }) => ({ type, memory, cpu })),
}));
ipcMain.handle('overlay:mode', (_event, value) => { mode = value; });
ipcMain.handle('overlay:resize', (event, { width, height }) => {
  BrowserWindow.fromWebContents(event.sender).setContentSize(width, height);
});
ipcMain.handle('overlay:capture', async (event, rect) => {
  if (mode === 'failed' || mode === 'missing') return null;
  const win = BrowserWindow.fromWebContents(event.sender);
  const [width, height] = win.getContentSize();
  const bounds = backdropCaptureBounds(rect, event.sender.getZoomFactor(), { width, height });
  if (!bounds) return null;
  if (mode === 'late') await new Promise(resolve => setTimeout(resolve, 350));
  const start = performance.now();
  try {
    const image = await event.sender.capturePage(bounds);
    const captured = performance.now();
    if (image.isEmpty()) {
      captureMetrics.push({ outcome: 'empty', captureMs: captured - start });
      return null;
    }
    const resized = image.resize({ width: backdropImageWidth(bounds), quality: 'good' });
    const scaled = performance.now();
    const url = resized.toDataURL();
    const encoded = performance.now();
    captureMetrics.push({ outcome: 'success', captureMs: captured - start, resizeMs: scaled - captured, encodeMs: encoded - scaled, totalMs: encoded - start, dataUrlChars: url.length, sourceSize: image.getSize(), outputSize: resized.getSize() });
    if (captureMetrics.length > 512) captureMetrics.shift();
    return url;
  } catch (error) {
    captureMetrics.push({ outcome: 'rejected', captureMs: performance.now() - start, error: String(error) });
    return null;
  }
});
app.whenReady().then(() => {
  const vibrancy = process.platform === 'darwin' && process.env.MICHI_NO_VIBRANCY !== '1';
  const window = new BrowserWindow({
    width: 1440, height: 960, show: true,
    title: 'Michi overlay test — synthetic data',
    ...(vibrancy
      ? { vibrancy: 'under-window', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
      : { backgroundColor: '#F5F2EE' }),
    webPreferences: {
      preload: path.join(__dirname, 'overlayElectronPreload.cjs'),
      additionalArguments: [
        ...(vibrancy ? ['--overlay-vibrancy'] : []),
        ...(mode === 'missing' ? ['--overlay-capture-missing'] : []),
      ],
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  void window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
