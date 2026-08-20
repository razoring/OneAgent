const { ipcRenderer } = require('electron');

(window as any).electronAPI = {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  fetchModels: (config: any) => ipcRenderer.invoke('fetch-models', config),
  chatComplete: (config: any) => ipcRenderer.invoke('chat-complete', config),
};
