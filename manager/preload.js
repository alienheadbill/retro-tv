const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (...args) => ipcRenderer.invoke(name, ...args);

contextBridge.exposeInMainWorld('library', {
  overview: call('lib:overview'),
  search: call('lib:search'),
  item: call('lib:item'),
  enqueue: call('lib:enqueue'),
  jobs: call('lib:jobs'),
  job: call('lib:job'),
  update: call('lib:update'),
  assign: call('lib:assign'),
  importFiles: call('lib:import'),
  probe: call('lib:probe'),
  hash: call('lib:hash'),
  describeConversion: call('lib:convert-describe'),
  convert: call('lib:convert'),
  conversionJob: call('lib:convert-job'),
  openSource: call('lib:open-source'),
  reveal: call('lib:reveal'),
  createChannel: call('lib:channel-create'),
  channelSettings: call('lib:channel-settings'),
  exportPhone: call('lib:export-phone'),
  home: call('lib:home'),
  linked: call('lib:linked'),
  health: call('lib:health'),
  onEvent: (cb) => ipcRenderer.on('lib:event', (_e, msg) => cb(msg)),
});
