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
  dialogShowOpen: (opts: any) => ipcRenderer.invoke('dialog-show-open', opts),
  chromeLaunch: (opts: any) => ipcRenderer.invoke('chrome-launch', opts),
  chromeForceRelaunch: (opts: any) => ipcRenderer.invoke('chrome-force-relaunch', opts),
  chromeStatus: (port?: number) => ipcRenderer.invoke('chrome-status', port),
  chromeListTargets: (port?: number) => ipcRenderer.invoke('chrome-list-targets', port),
  cdpNewTarget: (opts: any) => ipcRenderer.invoke('cdp-new-target', opts),
  cdpCloseTarget: (opts: any) => ipcRenderer.invoke('cdp-close-target', opts),
  cdpSend: (opts: any) => ipcRenderer.invoke('cdp-send', opts),
  createAgentBrowser: (agentId: string, initialUrl?: string) => ipcRenderer.invoke('create-agent-browser', { agentId, initialUrl }),
  destroyAgentBrowser: (agentId: string) => ipcRenderer.invoke('destroy-agent-browser', { agentId }),
  takeControl: (agentId: string) => ipcRenderer.invoke('take-control', agentId),
  returnToChat: () => ipcRenderer.invoke('return-to-chat'),
  browserUpdateBounds: (bounds: any) => ipcRenderer.invoke('browser-update-bounds', bounds),
  browserNavigate: (url: string) => ipcRenderer.invoke('browser-navigate', url),
  browserCreateTab: (agentId: string, tabId: string, url?: string) => ipcRenderer.invoke('browser-create-tab', { agentId, tabId, url }),
  browserSwitchTab: (agentId: string, tabId: string) => ipcRenderer.invoke('browser-switch-tab', { agentId, tabId }),
  browserCloseTab: (agentId: string, tabId: string) => ipcRenderer.invoke('browser-close-tab', { agentId, tabId }),
  browserParkTab: (agentId: string, tabId: string) => ipcRenderer.invoke('browser-park-tab', { agentId, tabId }),
  browserUnparkTab: (agentId: string, tabId: string) => ipcRenderer.invoke('browser-unpark-tab', { agentId, tabId }),
  browserGetTabs: (agentId: string) => ipcRenderer.invoke('browser-get-tabs', { agentId }),
  browserListAllTabs: () => ipcRenderer.invoke('browser-list-all-tabs'),
  browserAgentEnsureTab: (agentId: string, url?: string) => ipcRenderer.invoke('browser-agent-ensure-tab', { agentId, url }),
  onBrowserTabUpdated: (cb: (data: any) => void) => { const h = (_: any, d: any) => cb(d); ipcRenderer.on('browser-tab-updated', h); return () => ipcRenderer.removeListener('browser-tab-updated', h); },
  onBrowserTabClosed: (cb: (data: any) => void) => { const h = (_: any, d: any) => cb(d); ipcRenderer.on('browser-tab-closed', h); return () => ipcRenderer.removeListener('browser-tab-closed', h); },
  // Standalone (shared partition, no agentId required; uses __standalone__)
  standaloneCreateTab: (tabId: string, url?: string) => ipcRenderer.invoke('standalone-create-tab', { tabId, url }),
  standaloneSwitchTab: (tabId: string) => ipcRenderer.invoke('standalone-switch-tab', { tabId }),
  standaloneGetTabs: () => ipcRenderer.invoke('standalone-get-tabs'),
  standaloneNavigate: (url: string, tabId?: string) => ipcRenderer.invoke('standalone-navigate', { url, tabId }),
  standaloneUpdateBounds: (bounds: any) => ipcRenderer.invoke('standalone-update-bounds', bounds),
  standaloneEnter: () => ipcRenderer.invoke('standalone-enter'),
  standaloneLeave: () => ipcRenderer.invoke('standalone-leave'),
  // Extensions (MV2+MV3) + CWS
  extensionsList: () => ipcRenderer.invoke('extensions-list'),
  extensionsLoadFile: (filePath: string) => ipcRenderer.invoke('extensions-load-file', { filePath }),
  extensionsRemove: (extensionId: string) => ipcRenderer.invoke('extensions-remove', { extensionId }),
  extensionsInstallFromStore: (urlOrId: string) => ipcRenderer.invoke('extensions-install-from-store', { urlOrId }),
  extensionsOpenStore: (url?: string) => ipcRenderer.invoke('extensions-open-store', { url }),
  cdpCommand: (opts: any) => ipcRenderer.invoke('cdp-command', opts),

  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),
  desktopClick: (opts: { x: number, y: number, button?: string, double?: boolean }) => ipcRenderer.invoke('desktop-click', opts),
  desktopDrag: (opts: { fromX: number, fromY: number, toX: number, toY: number }) => ipcRenderer.invoke('desktop-drag', opts),
  desktopType: (text: string) => ipcRenderer.invoke('desktop-type', { text }),
  desktopHotkey: (opts: { keys: string[] }) => ipcRenderer.invoke('desktop-hotkey', opts),

  // Chat history (flat, no sub-agent nesting) — tasks are persisted alongside messages per chat
  chatsList: () => ipcRenderer.invoke('chats-list'),
  chatsLoad: (chatId: string) => ipcRenderer.invoke('chats-load', chatId),
  chatsSave: (chatId: string, payload: { meta?: any; messages?: any[]; tasks?: any[] }) => ipcRenderer.invoke('chats-save', chatId, payload),
  chatsCreate: (spec: { parentId?: string | null; title?: string }) => ipcRenderer.invoke('chats-create', spec),
  chatsRename: (chatId: string, title: string) => ipcRenderer.invoke('chats-rename', chatId, title),
  chatsDelete: (chatId: string) => ipcRenderer.invoke('chats-delete', chatId),
  chatsExportZip: (chatId: string) => ipcRenderer.invoke('chats-export-zip', chatId),
};
