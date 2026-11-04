'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: (opts) => ipcRenderer.invoke('file:open-dialog', opts),
  readFile: (p) => ipcRenderer.invoke('file:read', p),
  save: (payload) => ipcRenderer.invoke('file:save', payload),
  saveAs: (payload) => ipcRenderer.invoke('file:save-as', payload),
  listFonts: () => ipcRenderer.invoke('fonts:list'),
  readFont: (spec) => ipcRenderer.invoke('fonts:read', spec),
  setDirty: (isDirty, name) => ipcRenderer.send('app:dirty', { isDirty, name }),
  closeNow: () => ipcRenderer.send('app:close-now'),
  onCommand: (cb) => ipcRenderer.on('command', (_e, c) => cb(c)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
});
