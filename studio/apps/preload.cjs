'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioDesktop', {
  state: () => ipcRenderer.invoke('studio-desktop:state'),
  chooseProject: () => ipcRenderer.invoke('studio-desktop:choose-project'),
  connect: value => ipcRenderer.invoke('studio-desktop:connect', value),
  cancel: () => ipcRenderer.invoke('studio-desktop:cancel'),
  onStatus: handler => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('studio-desktop:status', listener);
    return () => ipcRenderer.removeListener('studio-desktop:status', listener);
  },
});
