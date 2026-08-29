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
  browserCapture: (webContentsId: number | string) => ipcRenderer.invoke('browser-capture', webContentsId),
  browserEmulateDevice: (webContentsId: number | string, options: any) => ipcRenderer.invoke('browser-emulate-device', webContentsId, options),
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

  // Chat history
  chatsList: () => ipcRenderer.invoke('chats-list'),
  chatsLoad: (chatId: string) => ipcRenderer.invoke('chats-load', chatId),
  chatsSave: (chatId: string, payload: { meta?: any; messages?: any[] }) => ipcRenderer.invoke('chats-save', chatId, payload),
  chatsCreate: (spec: { parentId?: string | null; title?: string; agentId?: string }) => ipcRenderer.invoke('chats-create', spec),
  chatsRename: (chatId: string, title: string) => ipcRenderer.invoke('chats-rename', chatId, title),
  chatsDelete: (chatId: string) => ipcRenderer.invoke('chats-delete', chatId),
  chatsExportZip: (chatId: string) => ipcRenderer.invoke('chats-export-zip', chatId),

  // Browser shell — link targets open as new tabs in the shared browser
  onBrowserNewTab: (callback: (url: string) => void) => {
    const handler = (_e: any, url: string) => callback(url);
    ipcRenderer.on('oneagent-browser-new-tab', handler);
    return () => ipcRenderer.removeListener('oneagent-browser-new-tab', handler);
  },

  // WebContentsView tab substrate (embedded headless + live-in-container)
  tabCreate: (options?: string | { url?: string; bounds?: any; agentId?: string }) =>
    ipcRenderer.invoke('browser-tab-create', options),
  tabClose: (tabId: string) => ipcRenderer.invoke('browser-tab-close', tabId),
  tabActivate: (id: string, bounds?: any) => ipcRenderer.invoke('browser-tab-activate', { id, bounds }),
  tabHide: (tabId: string) => ipcRenderer.invoke('browser-tab-hide', tabId),
  tabHideAll: () => ipcRenderer.invoke('browser-tab-hide-all'),
  tabBounds: (id: string, bounds: any) => ipcRenderer.invoke('browser-tab-bounds', { id, bounds }),
  tabShowInContainer: (id: string, bounds: any) => ipcRenderer.invoke('browser-tab-show-in-container', { id, bounds }),
  tabHideInContainer: (id: string) => ipcRenderer.invoke('browser-tab-hide-in-container', { id }),
  tabCall: (id: string, method: string, arg?: any) => ipcRenderer.invoke('browser-tab-call', { id, method, arg }),
  tabState: (id: string) => ipcRenderer.invoke('browser-tab-state', id),
  tabExec: (id: string, code: string) => ipcRenderer.invoke('browser-tab-exec', { id, code }),
  tabGetByAgent: (agentId: string) => ipcRenderer.invoke('browser-tab-get-by-agent', agentId),
  tabList: () => ipcRenderer.invoke('browser-tab-list'),
  tabShow: (tabId: string) => ipcRenderer.invoke('browser-tab-show', tabId),
  tabHideWindow: (tabId: string) => ipcRenderer.invoke('browser-tab-hide-window', tabId),
  onTabEvent: (callback: (ev: { tabId: string } & Record<string, any>) => void) => {
    const handler = (_e: any, ev: any) => callback(ev);
    ipcRenderer.on('browser-tab-event', handler);
    return () => ipcRenderer.removeListener('browser-tab-event', handler);
  },
};
