const { ipcRenderer, webUtils } = require('electron');

(window as any).electronAPI = {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  fetchModels: (config: any) => ipcRenderer.invoke('fetch-models', config),
  chatComplete: (config: any) => ipcRenderer.invoke('chat-complete', config),
  chatStream: (config: any) => ipcRenderer.invoke('chat-stream', config),
  flushModel: (config: any) => ipcRenderer.invoke('flush-model', config),
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
  embedTexts: (texts: string[]) => ipcRenderer.invoke('embed-texts', texts),
  ragSearch: (options: any) => ipcRenderer.invoke('rag-search', options),
  getFileThumbnail: (filePath: string) => ipcRenderer.invoke('get-file-thumbnail', filePath),
  openPath: (filePath: string) => ipcRenderer.send('open-path', filePath),
  getPathForFile: (file: File) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (e) {}
    return (file as any).path || '';
  },
};
