const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tv', {
  config: () => ipcRenderer.invoke('config'),
  durations: () => ipcRenderer.invoke('durations:get'),
  saveDurations: (data) => ipcRenderer.invoke('durations:set', data),
  status: (number, force) => ipcRenderer.invoke('channel:status', number, !!force),
  nextDisplay: () => ipcRenderer.send('display:next'),
  openLibrary: () => ipcRenderer.send('library:open'),
  // Called when the library changes (downloads finish, files get assigned to channels).
  onChanged: (cb) => ipcRenderer.on('tv:changed', () => cb()),
  // Keys pressed while a channel's page had focus.
  onKey: (cb) => ipcRenderer.on('tv:key', (_e, k) => cb(k)),
  quit: () => ipcRenderer.send('quit'),
  // How the channels are playing, for the Library's Channel health tab.
  reportHealth: (data) => ipcRenderer.send('tv:health', data),
});
