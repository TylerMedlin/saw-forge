// The hub window's only way to reach the system: a small, fixed API.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['state', 'progress', 'hubUpdate']);
contextBridge.exposeInMainWorld('hub', {
  state: () => ipcRenderer.invoke('hub:state'),
  refresh: () => ipcRenderer.invoke('hub:refresh'),
  install: (id) => ipcRenderer.invoke('hub:install', id),
  cancel: (id) => ipcRenderer.invoke('hub:cancel', id),
  uninstall: (id) => ipcRenderer.invoke('hub:uninstall', id),
  launch: (id) => ipcRenderer.invoke('hub:launch', id),
  reveal: (what, id) => ipcRenderer.invoke('hub:reveal', what, id),
  open: (key) => ipcRenderer.invoke('hub:open', key),
  setSetting: (key, value) => ipcRenderer.invoke('hub:setting', key, value),
  hubUpdate: (action) => ipcRenderer.invoke('hub:hubUpdate', action),
  on: (event, fn) => {
    if (!EVENTS.has(event)) return () => {};
    const h = (_e, data) => fn(data);
    ipcRenderer.on('hub:' + event, h);
    return () => ipcRenderer.removeListener('hub:' + event, h);
  },
});
