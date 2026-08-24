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
  // Agent Tools
  viewFile: (filePath: string) => ipcRenderer.invoke('view-file', filePath),
  listDir: (dirPath: string) => ipcRenderer.invoke('list-dir', dirPath),
  writeToFile: (options: any) => ipcRenderer.invoke('write-to-file', options),
  replaceFileContent: (options: any) => ipcRenderer.invoke('replace-file-content', options),
  deleteFile: (filePath: string) => ipcRenderer.invoke('delete-file', filePath),
  runCommand: (command: string, cwd?: string) => ipcRenderer.invoke('run-command', { command, cwd }),
  grepSearch: (options: any) => ipcRenderer.invoke('grep-search', options),
  searchWeb: (options: { endpoint: string; apiKey?: string; query: string; limit?: number }) => ipcRenderer.invoke('search-web', options),
  
  browserSendInputEvent: (options: any) => ipcRenderer.invoke('browser-send-input-event', options),
  browserInsertText: (options: any) => ipcRenderer.invoke('browser-insert-text', options),
  browserCapture: (webContentsId: number) => ipcRenderer.invoke('browser-capture', webContentsId),
  browserEmulateDevice: (webContentsId: number, options: any) => ipcRenderer.invoke('browser-emulate-device', webContentsId, options),
  browserCookies: (options: any) => ipcRenderer.invoke('browser-cookies', options),
  browserHistory: (options: any) => ipcRenderer.invoke('browser-history', options),
  findInPage: (options: any) => ipcRenderer.invoke('find-in-page', options),
  browserDownload: (options: any) => ipcRenderer.invoke('browser-download', options),
  providerStatus: (options: any) => ipcRenderer.invoke('provider-status', options),
  vramUsage: () => ipcRenderer.invoke('vram-usage'),

  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  desktopClick: (opts: { x: number, y: number, button?: string, double?: boolean }) => ipcRenderer.invoke('desktop-click', opts),
  desktopDrag: (opts: { fromX: number, fromY: number, toX: number, toY: number }) => ipcRenderer.invoke('desktop-drag', opts),
  desktopType: (text: string) => ipcRenderer.invoke('desktop-type', { text }),
  desktopHotkey: (opts: { keys: string[] }) => ipcRenderer.invoke('desktop-hotkey', opts),
};
