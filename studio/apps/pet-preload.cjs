'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const send = (name, value) => ipcRenderer.send(`studio-pet:${name}`, value);
const on = (name, callback) => ipcRenderer.on(`studio-pet:${name}`, (_event, value) => callback(value));

// Preserve the existing pet renderer contract without exposing raw IPC or Node.
contextBridge.exposeInMainWorld('pet', {
  initial: () => ipcRenderer.invoke('studio-pet:initial'),
  onMode: callback => on('mode', callback),
  toggle: () => send('toggle'),
  collapse: () => send('collapse'), activate: pose => send('activate', pose),
  pointer: hit => send('pointer', Boolean(hit)),
  dragStart: () => send('drag-start'), dragMove: () => send('drag-move'), dragEnd: () => send('drag-end'),
});
