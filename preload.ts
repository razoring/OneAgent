const { ipcRenderer } = require('electron');

(window as any).electronAPI = {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  fetchModels: (config: any) => ipcRenderer.invoke('fetch-models', config),
  chatComplete: (config: any) => ipcRenderer.invoke('chat-complete', config),
  chatStream: (config: any) => ipcRenderer.invoke('chat-stream', config),
  abortChatStream: (streamId: string) => ipcRenderer.send('chat-stream-abort', streamId),
  onStreamDelta: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('chat-stream-delta', handler);
    return () => ipcRenderer.removeListener('chat-stream-delta', handler);
  },
  onStreamEnd: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('chat-stream-end', handler);
    return () => ipcRenderer.removeListener('chat-stream-end', handler);
  },
  onStreamError: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('chat-stream-error', handler);
    return () => ipcRenderer.removeListener('chat-stream-error', handler);
  },
  parseDocument: (options: any) => ipcRenderer.invoke('parse-document', options),
  getFileThumbnail: (filePath: string) => ipcRenderer.invoke('get-file-thumbnail', filePath),
};
