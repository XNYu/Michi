const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electron', process.argv.includes('--overlay-capture-missing') ? {} : {
  captureBackdrop: rect => ipcRenderer.invoke('overlay:capture', rect),
});
contextBridge.exposeInMainWorld('overlayDesktop', {
  setCaptureMode: mode => ipcRenderer.invoke('overlay:mode', mode),
  resize: size => ipcRenderer.invoke('overlay:resize', size),
  takeCaptureMetrics: () => ipcRenderer.invoke('overlay:metrics'),
  environment: () => ipcRenderer.invoke('overlay:environment'),
});
document.addEventListener('DOMContentLoaded', () => {
  if (process.argv.includes('--overlay-vibrancy')) document.documentElement.dataset.vibrancy = 'on';
}, { once: true });
