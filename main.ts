import { app, BrowserWindow, BaseWindow, WebContentsView, session, ipcMain, nativeImage, shell, desktopCapturer, screen, webContents, dialog, protocol, net, Menu } from 'electron';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import AdmZip from 'adm-zip';
import * as officeParser from 'officeparser';

// chat-asset:// must be registered as privileged before app ready so the
// renderer can load local images through it over both http (dev) and file (prod).
protocol.registerSchemesAsPrivileged([
  { scheme: 'chat-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);


let mainWindow: BaseWindow | null = null;
let reactView: WebContentsView | null = null;
const agentViews = new Map<string, WebContentsView>();
let activeAgentViewId: string | null = null;
let extensionsManager: ElectronChromeExtensions | null = null;

// ─── Per-agent tab views (real tabs) ──────────────────────────────────────
const browserTabs = new Map<string, Map<string, WebContentsView>>(); // agentId -> tabId -> view
const browserTabMeta = new Map<string, { url: string; title: string; loading: boolean; parked: boolean; favicon?: string; canGoBack?: boolean; canGoForward?: boolean }>(); // `${agentId}::${tabId}`
const activeTabForAgent = new Map<string, string>();
// per-agent last bounds so standalone/agent switches don't clobber each other
const lastBrowserBoundsForAgent = new Map<string, { x: number; y: number; width: number; height: number }>();
const lastActiveAt = new Map<string, number>(); // tabKey -> timestamp
const suspendTimers = new Map<string, NodeJS.Timeout>();
const AUTO_SUSPEND_MS = 5 * 60 * 1000; // 5 min
const tabKey = (agentId: string, tabId: string) => `${agentId}::${tabId}`;
const getAgentTabs = (agentId: string) => {
  let m = browserTabs.get(agentId);
  if (!m) { m = new Map(); browserTabs.set(agentId, m); }
  return m;
};
const emitTabUpdate = (agentId: string, tabId: string) => {
  const meta = browserTabMeta.get(tabKey(agentId, tabId));
  if (!meta || !reactView || reactView.webContents.isDestroyed()) return;
  reactView.webContents.send('browser-tab-updated', { agentId, tabId, ...meta });
};
const scheduleAutoSuspend = (agentId: string, tabId: string) => {
  const key = tabKey(agentId, tabId);
  if (suspendTimers.has(key)) clearTimeout(suspendTimers.get(key)!);
  // never suspend active tab
  if (activeTabForAgent.get(agentId) === tabId) return;
  const meta = browserTabMeta.get(key);
  if (!meta || meta.parked) return;
  const view = browserTabs.get(agentId)?.get(tabId);
  if (!view || view.webContents.isDestroyed()) return;
  // don't suspend audible tabs
  try { if ((view.webContents as any).isCurrentlyAudible?.()) return; } catch {}
  const timer = setTimeout(() => {
    suspendTimers.delete(key);
    const curMeta = browserTabMeta.get(key);
    const curView = browserTabs.get(agentId)?.get(tabId);
    if (!curMeta || !curView || curView.webContents.isDestroyed()) return;
    if (activeTabForAgent.get(agentId) === tabId) return;
    try { if ((curView.webContents as any).isCurrentlyAudible?.()) { scheduleAutoSuspend(agentId, tabId); return; } } catch {}
    curMeta.parked = true;
    try { mainWindow?.contentView.removeChildView(curView); } catch {}
    try { (curView.webContents as any).setBackgroundThrottling?.(true); } catch {}
    try { curView.webContents.setAudioMuted(true); } catch {}
    emitTabUpdate(agentId, tabId);
    console.log(`[tabs] auto-suspended ${key}`);
  }, AUTO_SUSPEND_MS);
  suspendTimers.set(key, timer);
};
const cancelAutoSuspend = (agentId: string, tabId: string) => {
  const key = tabKey(agentId, tabId);
  const t = suspendTimers.get(key);
  if (t) { clearTimeout(t); suspendTimers.delete(key); }
};
const attachTabEvents = (view: WebContentsView, agentId: string, tabId: string) => {
  const key = tabKey(agentId, tabId);
  const updateMeta = (patch: Partial<{ url: string; title: string; loading: boolean; favicon?: string; canGoBack?: boolean; canGoForward?: boolean }>) => {
    const cur = browserTabMeta.get(key);
    if (!cur) return;
    Object.assign(cur, patch);
    // keep nav state fresh
    try {
      cur.canGoBack = view.webContents.canGoBack();
      cur.canGoForward = view.webContents.canGoForward();
    } catch {}
    emitTabUpdate(agentId, tabId);
  };
  const touchActive = () => {
    lastActiveAt.set(key, Date.now());
    cancelAutoSuspend(agentId, tabId);
    // schedule suspend for other tabs that went inactive
    const tabs = browserTabs.get(agentId);
    if (tabs) for (const [tid] of tabs) if (tid !== tabId) scheduleAutoSuspend(agentId, tid);
  };
  view.webContents.on('did-start-loading', () => { updateMeta({ loading: true }); touchActive(); });
  view.webContents.on('did-stop-loading', () => { updateMeta({ loading: false, title: view.webContents.getTitle() || curTitle(), url: view.webContents.getURL() }); touchActive(); });
  view.webContents.on('did-navigate', (_e: any, url: string) => { updateMeta({ url }); touchActive(); });
  view.webContents.on('did-navigate-in-page', (_e: any, url: string) => { updateMeta({ url }); touchActive(); });
  // HTTP 30x redirects don't always fire did-navigate until commit — listen explicitly so URL bar updates immediately
  view.webContents.on('did-redirect-navigation' as any, (_e: any, url: string) => { updateMeta({ url }); touchActive(); });
  view.webContents.on('page-title-updated', (_e: any, title: string) => updateMeta({ title }));
  view.webContents.on('page-favicon-updated', (_e: any, favicons: string[]) => {
    if (favicons && favicons[0]) updateMeta({ favicon: favicons[0] });
  });
  view.webContents.on('did-fail-load', (_e: any, code: number, desc: string, url: string, isMainFrame: boolean) => {
    if (!isMainFrame || code === -3) return;
    updateMeta({ loading: false });
  });
  const curTitle = () => view.webContents.getTitle() || browserTabMeta.get(key)?.title || 'New Tab';
};

const createWindow = () => {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  const extSession = session.fromPartition('persist:oneagent_browser');
  extensionsManager = new ElectronChromeExtensions({ session: extSession, license: 'GPL-3.0' });
  try { ElectronChromeExtensions.handleCRXProtocol(extSession); } catch (e) { console.warn('[extensions] handleCRXProtocol failed', e); }

  mainWindow = new BaseWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: '#171717',
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 10 } }
      : isWindows
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: '#171717', symbolColor: '#d1d5db', height: 36 }
          }
        : {}),
  });

  mainWindow.setMenu(null);

  reactView = new WebContentsView({
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.contentView.addChildView(reactView);

  const getViewBounds = () => {
    if (!mainWindow) return { x: 0, y: 0, width: 1200, height: 800 };
    const [width, height] = mainWindow.getContentSize();
    return { x: 0, y: 0, width, height };
  };

  // Set initial bounds synchronously — BaseWindow 'resize' won't fire on creation
  reactView.setBounds(getViewBounds());

  const resizeViews = () => {
    const bounds = getViewBounds();
    if (reactView) reactView.setBounds(bounds);
    for (const view of agentViews.values()) {
      view.setBounds(bounds);
    }
  };

  mainWindow.on('resize', resizeViews);
  // BaseWindow has no 'ready-to-show' — show explicitly
  mainWindow.show();

  reactView.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const file = sourceId ? sourceId.split('/').pop() : '?';
    console.log(`[Renderer Console]: ${message} (${file}:${line})`);
  });
  reactView.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (code === -3) return; // aborted, navigation superseded
    console.error(`[reactView] did-fail-load ${code} ${desc} — ${url}`);
  });
  reactView.webContents.on('did-finish-load', () => {
    console.log('[reactView] did-finish-load', reactView!.webContents.getURL());
    resizeViews();
  });

  if (!app.isPackaged) {
    reactView.webContents.loadURL('http://localhost:5173').catch(err => {
      console.error('[reactView] loadURL failed — is vite running on :5173?', err.message);
    });
  } else {
    reactView.webContents.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
  }
};

ipcMain.handle('create-agent-browser', async (event, { agentId, initialUrl }) => {
  const id = agentId || 'default';
  if (agentViews.has(id)) {
    const existing = agentViews.get(id)!;
    if (initialUrl && existing.webContents.getURL() !== initialUrl) {
      existing.webContents.loadURL(initialUrl).catch(() => {});
    }
    return { success: true, webContentsId: existing.webContents.id };
  }
  
  const extSession = session.fromPartition('persist:oneagent_browser');
  const view = new WebContentsView({
    webPreferences: {
      session: extSession,
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  if (mainWindow) {
    const [width, height] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    // Add view behind reactView if reactView is active so Chromium renders it
    if (reactView && activeAgentViewId === null) {
      try { mainWindow.contentView.addChildView(view, 0); } catch {}
    }
  }

  agentViews.set(id, view);
  
  if (initialUrl) {
    view.webContents.loadURL(initialUrl).catch(err => {
      console.error('[agentBrowser] loadURL failed:', err.message);
    });
  }

  return { success: true, webContentsId: view.webContents.id };
});

ipcMain.handle('destroy-agent-browser', async (event, { agentId }) => {
  const id = agentId || 'default';
  // Close all tab views for this agent
  const tabs = browserTabs.get(id);
  if (tabs) {
    for (const [tid, v] of tabs) {
      if (activeTabForAgent.get(id) === tid && mainWindow) {
        try { mainWindow.contentView.removeChildView(v); } catch {}
      }
      if (!v.webContents.isDestroyed()) v.webContents.close();
      browserTabMeta.delete(tabKey(id, tid));
    }
    browserTabs.delete(id);
    activeTabForAgent.delete(id);
  }
  const view = agentViews.get(id);
  if (view) {
    if (activeAgentViewId === id && mainWindow) {
      try { mainWindow.contentView.removeChildView(view); } catch {}
      if (reactView) try { mainWindow.contentView.addChildView(reactView); } catch {}
      activeAgentViewId = null;
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
    agentViews.delete(id);
  } else if (activeAgentViewId === id) {
    activeAgentViewId = null;
  }
  return { success: true };
});

ipcMain.handle('take-control', async (event, agentId) => {
  if (!mainWindow) return { success: false };
  const id = agentId || 'default';

  // If this agent has tab views, show the active tab instead of the legacy single view
  const tabs = browserTabs.get(id);
  const activeTid = tabs ? activeTabForAgent.get(id) : undefined;
  if (tabs && activeTid && tabs.has(activeTid)) {
    const tabView = tabs.get(activeTid)!;
    // Hide previous agent's tab view
    if (activeAgentViewId && activeAgentViewId !== id) {
      const prevTabs = browserTabs.get(activeAgentViewId);
      const prevTid = activeTabForAgent.get(activeAgentViewId);
      if (prevTabs && prevTid) {
        const prevView = prevTabs.get(prevTid);
        if (prevView) try { mainWindow.contentView.removeChildView(prevView); } catch {}
      }
      const prevLegacy = agentViews.get(activeAgentViewId);
      if (prevLegacy) try { mainWindow.contentView.removeChildView(prevLegacy); } catch {}
    }
    if (reactView) try { mainWindow.contentView.addChildView(reactView); } catch {}
    try { mainWindow.contentView.addChildView(tabView); } catch {}
    activeAgentViewId = id;
    const b0 = lastBrowserBoundsForAgent.get(id);
    if (b0) try { tabView.setBounds(b0 as any); } catch {}
    if (extensionsManager) try { extensionsManager.selectTab(tabView.webContents); } catch {}
    return { success: true, webContentsId: tabView.webContents.id };
  }

  let view = agentViews.get(id);
  if (!view && agentViews.size > 0) {
    view = Array.from(agentViews.values())[0];
  }
  if (!view) {
    const extSession = session.fromPartition('persist:oneagent_browser');
    view = new WebContentsView({
      webPreferences: { session: extSession, contextIsolation: true, nodeIntegration: false }
    });
    const [width, height] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    agentViews.set(id, view);
    view.webContents.on('before-input-event', (_event: any, input: any) => {
      if (input.type === 'keyDown' && input.key === 'F12') view?.webContents.toggleDevTools();
    });
    view.webContents.loadURL('https://duckduckgo.com').catch(() => {});
  }
  if (activeAgentViewId && agentViews.has(activeAgentViewId)) {
    const old = agentViews.get(activeAgentViewId);
    if (old && old !== view) try { mainWindow.contentView.removeChildView(old); } catch {}
  }
  // Also hide previous agent's active tab view
  if (activeAgentViewId && activeAgentViewId !== id) {
    const prevTabs = browserTabs.get(activeAgentViewId);
    const prevTid = activeTabForAgent.get(activeAgentViewId);
    if (prevTabs && prevTid) {
      const pv = prevTabs.get(prevTid);
      if (pv) try { mainWindow.contentView.removeChildView(pv); } catch {}
    }
  }
  if (reactView) try { mainWindow.contentView.addChildView(reactView); } catch {}
  try { mainWindow.contentView.addChildView(view); } catch {}
  activeAgentViewId = id;
  view.webContents.removeAllListeners('context-menu');
  view.webContents.on('context-menu', (_: any, params: any) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Back', click: () => view!.webContents.goBack(), enabled: view!.webContents.canGoBack() },
      { label: 'Forward', click: () => view?.webContents.goForward(), enabled: view?.webContents.canGoForward() },
      { label: 'Reload', click: () => view?.webContents.reload() },
      { type: 'separator' },
      { label: 'Copy', role: 'copy' },
      { label: 'Paste', role: 'paste' },
      { type: 'separator' },
      { label: 'Inspect Element', click: () => view?.webContents.inspectElement(params.x, params.y) },
    ]);
    menu.popup();
  });

  // Ensure extensions tab is synced to this view
  if (extensionsManager) {
    extensionsManager.selectTab(view.webContents);
  }
  
  return { success: true };
});

ipcMain.handle('return-to-chat', async () => {
  if (!mainWindow) return { success: false };
  // Hide active tab view if present
  if (activeAgentViewId) {
    const tid = activeTabForAgent.get(activeAgentViewId);
    const tview = tid ? browserTabs.get(activeAgentViewId)?.get(tid) : undefined;
    if (tview) {
      try { mainWindow.contentView.removeChildView(tview); } catch {}
      const meta = browserTabMeta.get(tabKey(activeAgentViewId, tid!));
      // Keep parked tabs throttled, active tabs just detached
      if (!meta?.parked) {
        try { mainWindow.contentView.addChildView(tview, 0); } catch {}
      }
    }
  }
  if (activeAgentViewId && agentViews.has(activeAgentViewId)) {
    const activeView = agentViews.get(activeAgentViewId);
    if (activeView) {
      try {
        mainWindow.contentView.removeChildView(activeView);
        mainWindow.contentView.addChildView(activeView, 0);
      } catch {}
    }
  }
  activeAgentViewId = null;
  return { success: true };
});
ipcMain.handle('browser-update-bounds', (event, bounds) => {
  // store per active agent or standalone
  const activeId = activeAgentViewId || '__standalone__';
  lastBrowserBoundsForAgent.set(activeId, bounds);
  lastBrowserBoundsForAgent.set('__standalone__', bounds); // keep in sync so standalone switch gets correct rect
  const activeTabId = activeAgentViewId ? activeTabForAgent.get(activeAgentViewId) : activeTabForAgent.get('__standalone__');
  const lookupId = activeAgentViewId || '__standalone__';
  if (lookupId && activeTabId) {
    const tabs = browserTabs.get(lookupId);
    const view = tabs?.get(activeTabId);
    if (view && !view.webContents.isDestroyed()) { try { view.setBounds(bounds); } catch {} return { success: true }; }
  }
  if (activeAgentViewId && agentViews.has(activeAgentViewId)) {
    const view = agentViews.get(activeAgentViewId);
    if (view && !view.webContents.isDestroyed()) try { view.setBounds(bounds); } catch {}
  }
  return { success: true };
});

ipcMain.handle('browser-navigate', (event, url) => {
  const pickActive = (): { id: string; tid: string } | null => {
    if (activeAgentViewId) {
      const tid = activeTabForAgent.get(activeAgentViewId);
      if (tid) return { id: activeAgentViewId, tid };
    }
    const sTid = activeTabForAgent.get('__standalone__');
    if (sTid) return { id: '__standalone__', tid: sTid };
    return null;
  };
  const picked = pickActive();
  if (picked) {
    const view = browserTabs.get(picked.id)?.get(picked.tid);
    if (view && !view.webContents.isDestroyed()) {
      if (url === 'back') { if (view.webContents.canGoBack()) view.webContents.goBack(); }
      else if (url === 'forward') { if (view.webContents.canGoForward()) view.webContents.goForward(); }
      else if (url === 'reload') view.webContents.reload();
      else if (url === 'stop') view.webContents.stop();
      else view.webContents.loadURL(url).catch(() => {});
      return { success: true };
    }
  }
  if (activeAgentViewId && agentViews.has(activeAgentViewId)) {
    const view = agentViews.get(activeAgentViewId);
    if (view && !view.webContents.isDestroyed()) {
      if (url === 'back') { if (view.webContents.canGoBack()) view.webContents.goBack(); }
      else if (url === 'forward') { if (view.webContents.canGoForward()) view.webContents.goForward(); }
      else if (url === 'reload') view.webContents.reload();
      else if (url === 'stop') view.webContents.stop();
      else view.webContents.loadURL(url).catch(() => {});
    }
  }
  return { success: true };
});

// ─── Browser tabs: real WebContentsView per tab + parking ───────────────────
const ensureTabView = (agentId: string, tabId: string, initialUrl?: string) => {
  const tabs = getAgentTabs(agentId);
  let view = tabs.get(tabId);
  if (view && !view.webContents.isDestroyed()) return view;
  const extSession = session.fromPartition('persist:oneagent_browser');
  view = new WebContentsView({
    webPreferences: { session: extSession, contextIsolation: true, nodeIntegration: false }
  });
  // Context menu + F12 + Ctrl+R/F5 etc.
  view.webContents.on('before-input-event', (_e: any, input: any) => {
    if (input.type === 'keyDown' && input.key === 'F12') { try { view!.webContents.toggleDevTools(); } catch {} }
    // Ctrl+R reload, Ctrl+Shift+R hard reload, Ctrl+W close tab signal handled in renderer via accelerator
  });
  // Don't clobber extensions handler repeatedly — remove only once at creation
  try { view.webContents.removeAllListeners('context-menu'); } catch {}
  view.webContents.on('context-menu', (_: any, params: any) => {
    if (!view || view.webContents.isDestroyed()) return;
    try {
      const template: any[] = [
        { label: 'Back', enabled: view.webContents.canGoBack(), click: () => { try { if (!view.webContents.isDestroyed()) view.webContents.goBack(); } catch {} } },
        { label: 'Forward', enabled: view.webContents.canGoForward(), click: () => { try { if (!view.webContents.isDestroyed()) view.webContents.goForward(); } catch {} } },
        { label: 'Reload', click: () => { try { if (!view.webContents.isDestroyed()) view.webContents.reload(); } catch {} } },
        { type: 'separator' },
      ];
      if (params.linkURL) {
        template.push(
          { label: 'Open Link in New Tab', click: () => {
            const newId = `tab-${Date.now()}`;
            try { ensureTabView(agentId, newId, params.linkURL); } catch {}
            // if this agent is active, switch to it on next tick
            setTimeout(() => { try { const apiTabs = browserTabs.get(agentId); if (apiTabs?.has(newId)) {/* lazy switch handled by renderer */} } catch {} }, 0);
          }},
          { label: 'Copy Link Address', click: () => { try { require('electron').clipboard.writeText(params.linkURL); } catch {} } },
          { type: 'separator' },
        );
      }
      if (params.srcURL) {
        template.push(
          { label: 'Copy Image Address', click: () => { try { require('electron').clipboard.writeText(params.srcURL); } catch {} } },
          { label: 'Save Image As…', click: () => { try { view.webContents.downloadURL(params.srcURL); } catch {} } },
          { type: 'separator' },
        );
      }
      if (params.selectionText) {
        template.push(
          { label: `Search for “${params.selectionText.slice(0, 30)}”`, click: () => {
            const q = encodeURIComponent(params.selectionText);
            const url = `https://duckduckgo.com/?q=${q}`;
            const nid = `tab-${Date.now()}`;
            try { ensureTabView(agentId, nid, url); } catch {}
          }},
          { type: 'separator' },
        );
      }
      template.push(
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Cut', role: 'cut' },
        { label: 'Select All', role: 'selectAll' },
        { type: 'separator' },
        { label: 'View Page Source', click: () => { try { const u = view.webContents.getURL(); const nid = `tab-${Date.now()}`; ensureTabView(agentId, nid, `view-source:${u}`); } catch {} } },
        { label: 'Save As…', click: () => { try { view.webContents.downloadURL(view.webContents.getURL()); } catch {} } },
        { label: 'Print…', click: () => { try { view.webContents.print({}); } catch {} } },
        { type: 'separator' },
        { label: 'Inspect Element', click: () => { try { if (!view.webContents.isDestroyed()) view.webContents.inspectElement(params.x, params.y); } catch {} } },
      );
      // Merge extension context menu items if any
      try {
        const extItems = extensionsManager?.getContextMenuItems(view.webContents as any, params as any) as any[];
        if (extItems && extItems.length) {
          template.splice(template.length - 2, 0, { type: 'separator' }, ...extItems);
        }
      } catch {}
      const menu = Menu.buildFromTemplate(template);
      // Electron 30+ prefers popup options object
      try { (menu as any).popup({ window: mainWindow! }); } catch { menu.popup(); }
    } catch (e) { console.error('[context-menu] failed', e); }
  });
  browserTabMeta.set(tabKey(agentId, tabId), { url: initialUrl || 'https://duckduckgo.com', title: 'New Tab', loading: false, parked: false });
  attachTabEvents(view, agentId, tabId);
  tabs.set(tabId, view);
  // new-window (_blank) → new tab in same agent/standalone group
  try {
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const nid = `tab-${Date.now()}`;
        ensureTabView(agentId, nid, url);
        // auto-switch if this agent is currently visible
        if (activeTabForAgent.get(agentId) && (activeAgentViewId === agentId || agentId === '__standalone__')) {
          // defer so ensure finishes
          setTimeout(() => {
            const tabs2 = browserTabs.get(agentId);
            const v2 = tabs2?.get(nid);
            if (v2 && mainWindow && !v2.webContents.isDestroyed()) {
              const prev = activeTabForAgent.get(agentId);
              if (prev && prev !== nid) {
                const pv = tabs2?.get(prev);
                if (pv) try { mainWindow.contentView.removeChildView(pv); } catch {}
              }
              activeTabForAgent.set(agentId, nid);
              try { mainWindow.contentView.addChildView(v2); } catch {}
              const b = lastBrowserBoundsForAgent.get(agentId);
              if (b) try { v2.setBounds(b as any); } catch {}
              try { (v2.webContents as any).setBackgroundThrottling?.(false); } catch {}
              if (extensionsManager) try { extensionsManager.selectTab(v2.webContents); } catch {}
              emitTabUpdate(agentId, nid);
              if (prev) emitTabUpdate(agentId, prev);
            }
          }, 0);
        }
      } catch {}
      return { action: 'deny' };
    });
  } catch {}
  if (initialUrl) view.webContents.loadURL(initialUrl).catch(() => {});
  else view.webContents.loadURL('https://duckduckgo.com').catch(() => {});
  return view;
};

ipcMain.handle('browser-create-tab', async (_e, { agentId, tabId, url }) => {
  if (!agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  ensureTabView(agentId, tabId, url);
  return { success: true };
});

ipcMain.handle('browser-switch-tab', async (_e, { agentId, tabId }) => {
  if (!mainWindow || !agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  const tabs = browserTabs.get(agentId);
  if (!tabs) return { success: false, error: 'no tabs for agent' };
  let view = tabs.get(tabId);
  if (!view || view.webContents.isDestroyed()) {
    const meta = browserTabMeta.get(tabKey(agentId, tabId));
    if (meta?.parked) {
      // auto-unpark on switch
      try { meta.parked = false; emitTabUpdate(agentId, tabId); } catch {}
    }
    view = ensureTabView(agentId, tabId, meta?.url);
  }
  const prevId = activeTabForAgent.get(agentId);
  if (prevId && prevId !== tabId) {
    const prevView = tabs.get(prevId);
    if (prevView && !prevView.webContents.isDestroyed()) {
      try { mainWindow.contentView.removeChildView(prevView); } catch {}
      const pk = tabKey(agentId, prevId);
      const pm = browserTabMeta.get(pk);
      const isParked = !!pm?.parked;
      if (isParked) {
        try { (prevView.webContents as any).setBackgroundThrottling?.(true); } catch {}
        try { prevView.webContents.setAudioMuted(true); } catch {}
      } else {
        // schedule auto-suspend for the tab we just left
        scheduleAutoSuspend(agentId, prevId);
      }
    }
  }
  activeTabForAgent.set(agentId, tabId);
  cancelAutoSuspend(agentId, tabId);
  lastActiveAt.set(tabKey(agentId, tabId), Date.now());
  const isVisibleAgent = activeAgentViewId === agentId || agentId === '__standalone__';
  // standalone check: if activeAgentViewId is null but standalone is being shown, also attach
  const shouldAttach = isVisibleAgent || (!activeAgentViewId && agentId === '__standalone__');
  if (shouldAttach) {
    try { mainWindow.contentView.addChildView(view); } catch {}
    const bounds = lastBrowserBoundsForAgent.get(agentId) || lastBrowserBoundsForAgent.get('__standalone__') || lastBrowserBoundsForAgent.get(activeAgentViewId || '') || null;
    if (bounds) { try { view.setBounds(bounds as any); } catch {} }
    else {
      const [w, h] = mainWindow.getContentSize();
      try { view.setBounds({ x: 0, y: 0, width: w, height: h } as any); } catch {}
    }
    // Defer a second bounds push to settle ResizeObserver race
    setTimeout(() => {
      const b = lastBrowserBoundsForAgent.get(agentId);
      if (b && !view!.webContents.isDestroyed()) try { view!.setBounds(b as any); } catch {}
    }, 60);
    try { (view.webContents as any).setBackgroundThrottling?.(false); } catch {}
    try { view.webContents.setAudioMuted(false); } catch {}
    if (extensionsManager) try { extensionsManager.selectTab(view.webContents); } catch {}
  }
  const meta = browserTabMeta.get(tabKey(agentId, tabId));
  if (meta) { meta.parked = false; meta.loading = meta.loading ?? false; }
  emitTabUpdate(agentId, tabId);
  if (prevId && prevId !== tabId) emitTabUpdate(agentId, prevId);
  return { success: true, webContentsId: view.webContents.id };
});

ipcMain.handle('browser-close-tab', async (_e, { agentId, tabId }) => {
  if (!agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  const key = tabKey(agentId, tabId);
  cancelAutoSuspend(agentId, tabId);
  lastActiveAt.delete(key);
  const tabs = browserTabs.get(agentId);
  const view = tabs?.get(tabId);
  if (!view) { browserTabMeta.delete(key); return { success: true }; }
  const isActive = activeTabForAgent.get(agentId) === tabId;
  if (isActive && mainWindow) {
    try { mainWindow.contentView.removeChildView(view); } catch {}
    activeTabForAgent.delete(agentId);
  }
  if (!view.webContents.isDestroyed()) try { view.webContents.close(); } catch {}
  tabs!.delete(tabId);
  browserTabMeta.delete(key);
  if (mainWindow && reactView && !reactView.webContents.isDestroyed()) {
    reactView.webContents.send('browser-tab-closed', { agentId, tabId });
  }
  return { success: true };
});

ipcMain.handle('browser-park-tab', async (_e, { agentId, tabId }) => {
  if (!agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  const key = tabKey(agentId, tabId);
  const view = browserTabs.get(agentId)?.get(tabId);
  const meta = browserTabMeta.get(key);
  if (!meta) return { success: false, error: 'tab not found' };
  meta.parked = true;
  cancelAutoSuspend(agentId, tabId);
  const isActive = activeTabForAgent.get(agentId) === tabId;
  if (isActive && mainWindow && view && !view.webContents.isDestroyed()) {
    try { mainWindow.contentView.removeChildView(view); } catch {}
    try { (view.webContents as any).setBackgroundThrottling?.(true); } catch {}
    try { view.webContents.setAudioMuted(true); } catch {}
    activeTabForAgent.delete(agentId);
  } else if (view && !view.webContents.isDestroyed()) {
    try { (view.webContents as any).setBackgroundThrottling?.(true); } catch {}
    try { view.webContents.setAudioMuted(true); } catch {}
  }
  emitTabUpdate(agentId, tabId);
  return { success: true };
});

ipcMain.handle('browser-unpark-tab', async (_e, { agentId, tabId }) => {
  const key = tabKey(agentId, tabId);
  const meta = browserTabMeta.get(key);
  if (!meta) return { success: false, error: 'tab not found' };
  meta.parked = false;
  const view = browserTabs.get(agentId)?.get(tabId);
  if (view && !view.webContents.isDestroyed()) {
    try { (view.webContents as any).setBackgroundThrottling?.(false); } catch {}
    try { view.webContents.setAudioMuted(false); } catch {}
  }
  lastActiveAt.set(key, Date.now());
  emitTabUpdate(agentId, tabId);
  // re-schedule auto suspend for others
  const tabs = browserTabs.get(agentId);
  if (tabs) for (const [tid] of tabs) if (tid !== tabId) scheduleAutoSuspend(agentId, tid);
  return { success: true };
});

ipcMain.handle('browser-get-tabs', async (_e, { agentId }) => {
  if (!agentId) return { success: false, error: 'agentId required' };
  const tabs = browserTabs.get(agentId);
  const list = tabs ? Array.from(tabs.keys()).map(tabId => ({ tabId, ...browserTabMeta.get(tabKey(agentId, tabId))! })) : [];
  return { success: true, tabs: list, activeTabId: activeTabForAgent.get(agentId) || null };
});

// Agents can discover user-created tabs (shared cookies via same persist:oneagent_browser session)
ipcMain.handle('browser-list-all-tabs', async () => {
  const all: any[] = [];
  for (const [agentId, tabs] of browserTabs.entries()) {
    for (const [tabId, view] of tabs.entries()) {
      const meta = browserTabMeta.get(tabKey(agentId, tabId));
      all.push({ agentId, tabId, url: meta?.url, title: meta?.title, loading: !!meta?.loading, parked: !!meta?.parked, favicon: meta?.favicon, active: activeTabForAgent.get(agentId) === tabId, destroyed: view.webContents.isDestroyed() });
    }
  }
  return { success: true, tabs: all };
});
// Let an agent adopt or create a tab in the shared user namespace (__standalone__)
ipcMain.handle('browser-agent-ensure-tab', async (_e, { agentId, url }) => {
  // Agents keep their own tab map for locking, but can optionally create in __standalone__ so user sees it
  const targetAgent = '__standalone__';
  const tabId = `agent-${agentId || 'anon'}-${Date.now()}`;
  const view = ensureTabView(targetAgent, tabId, url || 'https://duckduckgo.com');
  activeTabForAgent.set(targetAgent, tabId);
  // If no user window is active, don't auto-attach; otherwise attach to show user immediately
  if (mainWindow && !activeAgentViewId) {
    const b = lastBrowserBoundsForAgent.get(targetAgent);
    try { mainWindow.contentView.addChildView(view); } catch {}
    if (b) try { view.setBounds(b as any); } catch {}
  }
  return { success: true, agentId: targetAgent, tabId, url: view.webContents.getURL(), webContentsId: view.webContents.id };
});

// ─── Standalone browser (shared partition, independent of agent take-control) ─
// AgentId '__standalone__' uses same browserTabs map but separate activeTab + bounds
ipcMain.handle('standalone-create-tab', async (_e, { tabId, url }) => {
  if (!tabId) return { success: false, error: 'tabId required' };
  ensureTabView('__standalone__', tabId, url);
  return { success: true };
});
ipcMain.handle('standalone-switch-tab', async (_e, { tabId }) => {
  const agentId = '__standalone__';
  // Ensure the tab exists
  const tabs = getAgentTabs(agentId);
  if (!tabs.has(tabId)) {
    // let browser-create handle it
    ensureTabView(agentId, tabId, 'https://duckduckgo.com');
  }
  // If no agent is currently taking control, we show standalone directly
  // Otherwise standalone tabs live detached until return-to-chat / standalone enter
  const r: any = await (async () => {
    // Reuse browser-switch logic via direct call
    const view = browserTabs.get(agentId)?.get(tabId);
    if (!view) return { success: false };
    // DRY: call browser-switch-tab handler logic by emitting
    // Instead duplicate minimal logic here
    const prevId = activeTabForAgent.get(agentId);
    if (prevId && prevId !== tabId) {
      const prevView = tabs.get(prevId);
      if (prevView && !prevView.webContents.isDestroyed()) {
        try { mainWindow!.contentView.removeChildView(prevView); } catch {}
        scheduleAutoSuspend(agentId, prevId);
      }
    }
    activeTabForAgent.set(agentId, tabId);
    cancelAutoSuspend(agentId, tabId);
    lastActiveAt.set(tabKey(agentId, tabId), Date.now());
    // Only attach if no agent is active, or we are explicitly in standalone mode (reactView still present)
    const shouldAttach = !activeAgentViewId;
    if (shouldAttach && mainWindow && view && !view.webContents.isDestroyed()) {
      try { mainWindow.contentView.addChildView(view); } catch {}
      const b = lastBrowserBoundsForAgent.get(agentId) || lastBrowserBoundsForAgent.get('__standalone__');
      if (b) try { view.setBounds(b as any); } catch {}
      try { (view.webContents as any).setBackgroundThrottling?.(false); } catch {}
      try { view.webContents.setAudioMuted(false); } catch {}
      if (extensionsManager) try { extensionsManager.selectTab(view.webContents); } catch {}
    }
    const meta = browserTabMeta.get(tabKey(agentId, tabId));
    if (meta) meta.parked = false;
    emitTabUpdate(agentId, tabId);
    return { success: true, webContentsId: view.webContents.id };
  })();
  return r;
});
ipcMain.handle('standalone-get-tabs', async () => {
  const agentId = '__standalone__';
  const tabs = browserTabs.get(agentId);
  const list = tabs ? Array.from(tabs.keys()).map(tabId => ({ tabId, ...browserTabMeta.get(tabKey(agentId, tabId))! })) : [];
  return { success: true, tabs: list, activeTabId: activeTabForAgent.get(agentId) || null };
});
ipcMain.handle('standalone-navigate', async (_e, { tabId, url }) => {
  const agentId = '__standalone__';
  const tid = tabId || activeTabForAgent.get(agentId);
  if (!tid) return { success: false, error: 'no active standalone tab' };
  const view = browserTabs.get(agentId)?.get(tid);
  if (!view || view.webContents.isDestroyed()) return { success: false, error: 'view not found' };
  if (url === 'back') { if (view.webContents.canGoBack()) view.webContents.goBack(); }
  else if (url === 'forward') { if (view.webContents.canGoForward()) view.webContents.goForward(); }
  else if (url === 'reload') view.webContents.reload();
  else if (url === 'stop') view.webContents.stop();
  else view.webContents.loadURL(url).catch(() => {});
  return { success: true };
});
ipcMain.handle('standalone-update-bounds', async (_e, bounds) => {
  lastBrowserBoundsForAgent.set('__standalone__', bounds);
  const tid = activeTabForAgent.get('__standalone__');
  if (tid) {
    const view = browserTabs.get('__standalone__')?.get(tid);
    if (view && !view.webContents.isDestroyed() && !activeAgentViewId) {
      try { view.setBounds(bounds); } catch {}
    }
  }
  return { success: true };
});
ipcMain.handle('standalone-enter', async () => {
  if (!mainWindow) return { success: false };
  // Hide agent view if any
  if (activeAgentViewId) {
    const tid = activeTabForAgent.get(activeAgentViewId);
    const av = tid ? browserTabs.get(activeAgentViewId)?.get(tid) : agentViews.get(activeAgentViewId);
    if (av) try { mainWindow.contentView.removeChildView(av as any); } catch {}
    const legacy = agentViews.get(activeAgentViewId);
    if (legacy && legacy !== av) try { mainWindow.contentView.removeChildView(legacy); } catch {}
  }
  // Ensure standalone tab exists
  let tid = activeTabForAgent.get('__standalone__');
  if (!tid) {
    tid = `tab-${Date.now()}`;
    ensureTabView('__standalone__', tid, 'https://duckduckgo.com');
    activeTabForAgent.set('__standalone__', tid);
  }
  const view = browserTabs.get('__standalone__')!.get(tid!)!;
  if (reactView) try { mainWindow.contentView.addChildView(reactView); } catch {}
  try { mainWindow.contentView.addChildView(view); } catch {}
  const b = lastBrowserBoundsForAgent.get('__standalone__');
  if (b) try { view.setBounds(b as any); } catch {}
  if (extensionsManager) try { extensionsManager.selectTab(view.webContents); } catch {}
  // Mark that we are in standalone mode by clearing activeAgentViewId but keeping standalone attached
  // Use a separate flag stored in activeTabForAgent
  return { success: true, tabId: tid, webContentsId: view.webContents.id };
});
ipcMain.handle('standalone-leave', async () => {
  if (!mainWindow) return { success: false };
  const tid = activeTabForAgent.get('__standalone__');
  if (tid) {
    const view = browserTabs.get('__standalone__')?.get(tid);
    if (view) try { mainWindow.contentView.removeChildView(view); } catch {}
  }
  return { success: true };
});

// ─── Extensions (MV2+MV3, shared session) ───────────────────────────────────
ipcMain.handle('extensions-list', async () => {
  try {
    const sess = session.fromPartition('persist:oneagent_browser');
    const all = (sess as any).getAllExtensions ? (sess as any).getAllExtensions() : [];
    // Fallback: enumerate via extension folder
    return { success: true, extensions: all.map((e: any) => ({ id: e.id, name: e.name, version: e.version, manifest: e.manifest, icons: (e.manifest?.icons) || null })) };
  } catch (e: any) { return { success: false, error: e.message }; }
});
ipcMain.handle('extensions-load-file', async (_e, { filePath }) => {
  try {
    const sess = session.fromPartition('persist:oneagent_browser');
    // filePath can be .crx, .zip, or unpacked folder
    let target = filePath;
    const stat = fs.statSync(target);
    if (stat.isFile() && target.endsWith('.crx')) {
      // Try direct load — Electron 43 supports CRX3; if fails, unzip manually
      try {
        const ext = await (sess as any).loadExtension(target, { allowFileAccess: true });
        return { success: true, extension: { id: ext.id, name: ext.name } };
      } catch (err: any) {
        // Fallback: unzip CRX (skip header) to temp
        const buf = fs.readFileSync(target);
        // CRX3 header is variable; use adm-zip after stripping; crude: find PK
        let zipBuf: Buffer = buf;
        const pk = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        if (pk > 0) zipBuf = buf.slice(pk);
        const tmp = path.join(app.getPath('temp'), `oneagent-ext-${Date.now()}`);
        fs.mkdirSync(tmp, { recursive: true });
        const zip = new AdmZip(zipBuf);
        zip.extractAllTo(tmp, true);
        const ext = await (sess as any).loadExtension(tmp, { allowFileAccess: true });
        return { success: true, extension: { id: ext.id, name: ext.name } };
      }
    } else if (stat.isFile() && target.endsWith('.zip')) {
      const tmp = path.join(app.getPath('temp'), `oneagent-ext-${Date.now()}`);
      fs.mkdirSync(tmp, { recursive: true });
      const zip = new AdmZip(target);
      zip.extractAllTo(tmp, true);
      const ext = await (sess as any).loadExtension(tmp, { allowFileAccess: true });
      return { success: true, extension: { id: ext.id, name: ext.name } };
    } else {
      const ext = await (sess as any).loadExtension(target, { allowFileAccess: true });
      return { success: true, extension: { id: ext.id, name: ext.name } };
    }
  } catch (e: any) { return { success: false, error: e.message }; }
});
ipcMain.handle('extensions-remove', async (_e, { extensionId }) => {
  try {
    const sess = session.fromPartition('persist:oneagent_browser');
    if ((sess as any).removeExtension) await (sess as any).removeExtension(extensionId);
    else return { success: false, error: 'removeExtension not available in this Electron version' };
    return { success: true };
  } catch (e: any) { return { success: false, error: e.message }; }
});
ipcMain.handle('extensions-install-from-store', async (_e, { urlOrId }) => {
  try {
    if (!urlOrId) return { success: false, error: 'urlOrId required' };
    let id = String(urlOrId).trim();
    const m = id.match(/([a-z]{32})/i);
    if (m) id = m[1].toLowerCase();
    if (!/^[a-z]{32}$/.test(id)) return { success: false, error: 'Invalid extension id (expected 32-char, got ' + id + ')' };
    // Fetch CRX via clients2 redirect — follow redirects manually
    const sess = session.fromPartition('persist:oneagent_browser');
    const prodVersion = process.versions.chrome || '120.0.0.0';
    const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=${encodeURIComponent(prodVersion)}&x=id%3D${id}%26installsource%3Dondemand%26uc`;
    const tmpCrx = path.join(app.getPath('temp'), `${id}-${Date.now()}.crx`);
    // Use net.fetch (Electron net) to handle Google redirects
    const res: any = await (net as any).fetch(crxUrl, { redirect: 'follow' } as any);
    if (!res.ok) return { success: false, error: `Store returned ${res.status} ${res.statusText}` };
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length < 100) return { success: false, error: 'Downloaded CRX too small — store may have blocked' };
    // Heuristic: CRX starts with Cr24, else assume zip
    fs.writeFileSync(tmpCrx, buf);
    // Try load directly
    try {
      const ext = await (sess as any).loadExtension(tmpCrx, { allowFileAccess: true });
      return { success: true, extension: { id: ext.id, name: ext.name } };
    } catch {
      // Unzip fallback
      let zipBuf: Buffer = buf;
      const pk = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      if (pk > 0) zipBuf = buf.slice(pk);
      else if (buf.slice(0, 4).toString() === 'Cr24') {
        // CRX3 header skip: Cr24 + version(4) + headerSize(4) = 12 bytes header + headerSize
        const headerSize = buf.readUInt32LE(8);
        zipBuf = buf.slice(12 + headerSize);
      }
      const tmpDir = path.join(app.getPath('temp'), `oneagent-ext-${id}-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const zip = new AdmZip(zipBuf);
      zip.extractAllTo(tmpDir, true);
      const ext = await (sess as any).loadExtension(tmpDir, { allowFileAccess: true });
      return { success: true, extension: { id: ext.id, name: ext.name } };
    }
  } catch (e: any) { return { success: false, error: e.message }; }
});
ipcMain.handle('extensions-open-store', async (_e, { url }) => {
  const target = url || 'https://chromewebstore.google.com/';
  // Open in standalone tab instead of external browser
  const tid = `tab-${Date.now()}`;
  ensureTabView('__standalone__', tid, target);
  activeTabForAgent.set('__standalone__', tid);
  if (!activeAgentViewId && mainWindow) {
    const view = browserTabs.get('__standalone__')!.get(tid)!;
    try { mainWindow.contentView.addChildView(view); } catch {}
    const b = lastBrowserBoundsForAgent.get('__standalone__');
    if (b) try { view.setBounds(b as any); } catch {}
    if (extensionsManager) try { extensionsManager.selectTab(view.webContents); } catch {}
  }
  return { success: true, tabId: tid };
});

// Generic internal CDP dispatcher for WebContentsView targets
ipcMain.handle('cdp-send', async (event, { webContentsId, method, params }) => {
  const view = Array.from(agentViews.values()).find(v => v.webContents.id === webContentsId);
  const wc = view ? view.webContents : webContents.fromId(webContentsId);
  if (!wc) return { success: false, error: 'WebContents not found' };

  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
      
      // Auto-enable standard domains on attach
      wc.debugger.sendCommand('Page.enable').catch(() => {});
      wc.debugger.sendCommand('Runtime.enable').catch(() => {});
      wc.debugger.sendCommand('Network.enable').catch(() => {});
      
      // Setup console message routing to IPC
      wc.debugger.on('message', (event, method, params) => {
        if (method === 'Runtime.consoleAPICalled') {
          // Send to renderer for logging
          if (reactView) {
            reactView.webContents.send('agent-console-message', { webContentsId, type: params.type, args: params.args });
          }
        } else if (method === 'Network.responseReceived') {
          const res = params.response;
          if (res && res.status >= 400 && reactView) {
            reactView.webContents.send('agent-network-error', { webContentsId, url: res.url, status: res.status });
          }
        } else if (method === 'Page.javascriptDialogOpening') {
          // Auto-handle dialogs
          wc.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        }
      });
    }

    const result = await wc.debugger.sendCommand(method as any, params);
    return { success: true, result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('window-minimize', () => {
  BrowserWindow.getFocusedWindow()?.minimize();
});

ipcMain.on('window-maximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.on('window-close', () => {
  BrowserWindow.getFocusedWindow()?.close();
});

ipcMain.on('open-path', async (event, filePath) => {
  console.log('[open-path] Opening:', filePath);
  if (!filePath) {
    console.warn('[open-path] No filePath provided');
    return;
  }
  const err = await shell.openPath(filePath);
  if (err) {
    console.error('[open-path] Failed to open path:', err);
  }
});

ipcMain.handle('fetch-models', async (event, config) => {
  try {
    const { endpoint, apiKey } = config;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const url = endpoint.endsWith('/') ? `${endpoint}models` : `${endpoint}/models`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// Unload a model from provider memory (Ollama native API).
ipcMain.handle('flush-model', async (event, config) => {
  try {
    const { baseUrl, model } = config;
    const url = baseUrl.endsWith('/') ? `${baseUrl}api/generate` : `${baseUrl}/api/generate`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
    await response.text();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// Some providers reject unknown reasoning params (or don't support thinking on a given model).
// Retry once without them when the 400 error mentions reasoning/thinking.
const stripReasoningParams = (payload: any): any => {
  const { reasoning_effort, reasoning, enable_thinking, ...rest } = payload || {};
  return rest;
};

const shouldRetryWithoutReasoning = (status: number, errText: string): boolean =>
  status === 400 && /reasoning|thinking/i.test(errText);

ipcMain.handle('chat-complete', async (event, config) => {
  try {
    const { endpoint, apiKey, payload } = config;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    // OpenRouter requires HTTP referer headers usually, but it will work without them (as a fallback).
    headers['HTTP-Referer'] = 'http://localhost:5173';
    headers['X-Title'] = 'OneAgent';

    //debug: log payload structure (truncate base64 data)
    const debugPayload = JSON.parse(JSON.stringify(payload));
    if (debugPayload.messages) {
      for (const msg of debugPayload.messages) {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'image_url' && part.image_url?.url) {
              part.image_url.url = part.image_url.url.substring(0, 60) + '...[truncated]';
            }
          }
        }
      }
    }
    console.log('[chat-complete] Payload structure:', JSON.stringify(debugPayload, null, 2));

    const url = endpoint.endsWith('/') ? `${endpoint}chat/completions` : `${endpoint}/chat/completions`;
    let response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errText = await response.text();
      if (shouldRetryWithoutReasoning(response.status, errText)) {
        console.warn('[chat-complete] Provider rejected reasoning params, retrying without them');
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(stripReasoningParams(payload)),
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status} - ${await response.text()}`);
        }
      } else {
        throw new Error(`HTTP error! status: ${response.status} - ${errText}`);
      }
    }
    const data = await response.json();
    return { success: true, data };
  } catch (error: any) {
    console.error('[chat-complete] Fetch error:', error, error.cause);
    return { success: false, error: error.cause ? `${error.message} (Cause: ${error.cause.message || error.cause})` : error.message };
  }
});

// Active streaming abort controllers
const _streamAbortControllers = new Map<string, AbortController>();

ipcMain.handle('chat-stream', async (event, { endpoint, apiKey, payload, streamId }) => {
  const controller = new AbortController();
  if (streamId) {
    _streamAbortControllers.set(streamId, controller);
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    headers['HTTP-Referer'] = 'http://localhost:5173';
    headers['X-Title'] = 'OneAgent';

    const url = endpoint.endsWith('/') ? `${endpoint}chat/completions` : `${endpoint}/chat/completions`;
    const streamPayload = { ...payload, stream: true };

    let response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamPayload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      if (shouldRetryWithoutReasoning(response.status, errText)) {
        console.warn('[chat-stream] Provider rejected reasoning params, retrying without them');
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(stripReasoningParams(streamPayload)),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status} - ${await response.text()}`);
        }
      } else {
        throw new Error(`HTTP error! status: ${response.status} - ${errText}`);
      }
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage: any = null;
    // Providers report why generation ended ('stop' | 'length' | ...) on the
    // final chunk. Needed so the renderer can detect silent max_tokens cutoffs.
    let lastFinishReason: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.replace(/^data:\s*/, '');
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          // Final chunk from most providers carries token usage for accounting.
          if (parsed.usage) lastUsage = parsed.usage;
          const choice = parsed.choices?.[0];
          if (choice) {
            if (choice.finish_reason) lastFinishReason = choice.finish_reason;
            const content = choice.delta?.content || '';
            const reasoning = choice.delta?.reasoning_content || choice.delta?.reasoning || choice.delta?.thinking || '';
            const toolCalls = choice.delta?.tool_calls;
            event.sender.send('chat-stream-delta', { streamId, content, reasoning, toolCalls });
          } else if (parsed.choices?.[0] === undefined && parsed.finish_reason) {
            lastFinishReason = parsed.finish_reason;
          }
        } catch {
          // Ignore incomplete chunk parse errors
        }
      }
    }

    event.sender.send('chat-stream-end', { streamId, usage: lastUsage, finishReason: lastFinishReason });
    return { success: true };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      event.sender.send('chat-stream-end', { streamId });
      return { success: true, aborted: true };
    }
    console.error('[chat-stream] Error:', error);
    const errorMessage = error.cause ? `${error.message} (Cause: ${error.cause.message || error.cause})` : error.message;
    event.sender.send('chat-stream-error', { streamId, error: errorMessage });
    return { success: false, error: errorMessage };
  } finally {
    if (streamId) {
      _streamAbortControllers.delete(streamId);
    }
  }
});

ipcMain.on('chat-stream-abort', (event, streamId) => {
  if (streamId && _streamAbortControllers.has(streamId)) {
    _streamAbortControllers.get(streamId)?.abort();
    _streamAbortControllers.delete(streamId);
  }
});

// Helper for document text sanitization
function sanitizeExtractedText(text: string, maxChars: number = 150000): string {
  if (!text) return '';
  let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  cleaned = cleaned.replace(/\r\n/g, '\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  if (cleaned.length > maxChars) {
    const total = cleaned.length;
    cleaned = cleaned.slice(0, maxChars) + `\n\n[... Document truncated: Showing first ${maxChars.toLocaleString()} of ${total.toLocaleString()} characters to fit model context ...]`;
  }
  return cleaned.trim();
}

function cleanHtmlText(html: string): string {
  if (!html) return '';
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n# $1\n\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n* $1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  return sanitizeExtractedText(
    text
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n')
  );
}

function parseMhtmlText(mhtml: string): string {
  if (!mhtml) return '';
  const boundaryMatch = mhtml.match(/boundary="?([^"\r\n]+)"?/i);
  if (!boundaryMatch) return cleanHtmlText(mhtml);
  const boundary = boundaryMatch[1];
  const parts = mhtml.split(new RegExp(`--${boundary}(?:--)?`, 'g'));

  for (const part of parts) {
    if (/Content-Type:\s*text\/html/i.test(part) || /Content-Type:\s*text\/plain/i.test(part)) {
      const isQuotedPrintable = /Content-Transfer-Encoding:\s*quoted-printable/i.test(part);
      const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(part);
      const isPlain = /Content-Type:\s*text\/plain/i.test(part);
      const bodyIndex = part.indexOf('\n\n') !== -1 ? part.indexOf('\n\n') : part.indexOf('\r\n\r\n');
      let body = bodyIndex !== -1 ? part.slice(bodyIndex) : part;

      if (isQuotedPrintable) {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      } else if (isBase64) {
        try {
          body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
        } catch {}
      }
      return isPlain ? sanitizeExtractedText(body) : cleanHtmlText(body);
    }
  }
  return cleanHtmlText(mhtml);
}

ipcMain.handle('parse-document', async (event, { filePath, fileBuffer, fileName }) => {
  try {
    const { chunkText, parsePdfToChunks, parsePptxToChunks } = await import('./rag.js');
    const ext = (fileName || filePath || '').toLowerCase().split('.').pop() || '';
    const source = fileName || (filePath ? path.basename(filePath) : 'unknown');
    
    let buffer: Buffer | null = null;
    if (fileBuffer) {
      buffer = Buffer.from(fileBuffer);
    } else if (filePath && fs.existsSync(filePath)) {
      buffer = fs.readFileSync(filePath);
    }

    // 1. PDF
    if (ext === 'pdf' && buffer) {
      const chunks = await parsePdfToChunks(buffer, source);
      return { success: true, chunks, text: chunks.map((c: any) => c.text).join('\n\n') };
    }
    
    // 2. PPTX
    if (ext === 'pptx' && buffer) {
      const chunks = await parsePptxToChunks(buffer, source);
      return { success: true, chunks, text: chunks.map((c: any) => c.text).join('\n\n') };
    }

    // 3. Office & other formats
    if (['docx', 'xlsx', 'odt', 'odp', 'ods', 'rtf', 'epub'].includes(ext)) {
      try {
        let input: any = filePath;
        if ((!input || !fs.existsSync(input)) && buffer) {
          input = buffer;
        }
        if (input) {
          const parsed = await officeParser.parseOffice(input, {
            outputErrorToConsole: false,
            fileType: ext
          });
          const text = sanitizeExtractedText(typeof parsed.toText === 'function' ? parsed.toText() : String(parsed));
          return { success: true, chunks: chunkText(text, source), text };
        }
      } catch (err: any) {
        console.error('[parse-document] officeparser failed, fallback:', err);
      }
    }

    // 4. HTML
    if (['html', 'htm'].includes(ext)) {
      let rawHtml = buffer ? buffer.toString('utf-8') : '';
      const text = cleanHtmlText(rawHtml);
      return { success: true, chunks: chunkText(text, source), text };
    }

    // 5. MHTML
    if (['mhtml', 'mht'].includes(ext)) {
      let rawMhtml = buffer ? buffer.toString('utf-8') : '';
      const text = parseMhtmlText(rawMhtml);
      return { success: true, chunks: chunkText(text, source), text };
    }

    // 6. Standard text / code / CSV / JSON / Markdown
    let rawText = buffer ? buffer.toString('utf-8') : '';
    const text = sanitizeExtractedText(rawText);
    return { success: true, chunks: chunkText(text, source), text };
  } catch (err: any) {
    console.error('[parse-document] Error:', err);
    return { success: false, error: err.message || 'Failed to parse document' };
  }
});

ipcMain.handle('embed-texts', async (event, texts: string[]) => {
  try {
    const { embedTexts } = await import('./rag.js');
    const embeddings = await embedTexts(texts);
    return { success: true, embeddings };
  } catch (err: any) {
    console.error('[embed-texts] Error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('rag-search', async (event, { queryEmbedding, chunks, chunkEmbeddings, topK }) => {
  try {
    const { searchChunks } = await import('./rag.js');
    const topChunks = searchChunks(queryEmbedding, chunks, chunkEmbeddings, topK);
    return { success: true, topChunks };
  } catch (err: any) {
    console.error('[rag-search] Error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-file-thumbnail', async (event, filePath) => {
  try {
    // Generates a thumbnail image from the file (like in Windows Explorer)
    const thumb = await nativeImage.createThumbnailFromPath(filePath, { width: 256, height: 256 });
    if (!thumb.isEmpty()) {
      return thumb.toDataURL();
    }
  } catch (e) {
    console.error('Failed to get thumbnail for', filePath, e);
  }
  
  // Fallback to getting the basic file icon if thumbnail is not available
  try {
    const icon = await app.getFileIcon(filePath, { size: 'normal' });
    if (!icon.isEmpty()) {
      return icon.toDataURL();
    }
  } catch (e2) {
    console.error('Failed to get file icon for', filePath, e2);
  }
  return null;
});

import { exec } from 'child_process';
import nutJs from '@nut-tree-fork/nut-js';
const { keyboard, mouse, Point, Button, Key } = nutJs;

// Maps friendly key names ("control", "enter", "arrowup") onto the provider's
// Key enum, falling back to case variants so single letters/keys just work.
const KEY_ALIASES: Record<string, string> = {
  control: 'LeftControl', ctrl: 'LeftControl',
  alt: 'LeftAlt', option: 'LeftAlt',
  shift: 'LeftShift',
  cmd: 'LeftCmd', command: 'LeftCmd', meta: 'LeftCmd',
  win: 'LeftWindows', super: 'LeftSuper',
  enter: 'Return', return: 'Return',
  esc: 'Escape', space: 'Space',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  pageup: 'PageUp', pagedown: 'PageDown'
};

const resolveNutKey = (name: string) => {
  const n = String(name).trim();
  const alias = KEY_ALIASES[n.toLowerCase()];
  const candidates = [alias, n, n.charAt(0).toUpperCase() + n.slice(1), n.toUpperCase()].filter(Boolean);
  for (const c of candidates) {
    const k = (Key as any)[c];
    if (k !== undefined) return k;
  }
  throw new Error(`Unknown key "${name}"`);
};

// --- AGENT DESKTOP TOOLS IPC HANDLERS ---
ipcMain.handle('take-screenshot', async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'], 
      thumbnailSize: { width, height } 
    });
    if (sources.length > 0) {
      return { success: true, image: sources[0].thumbnail.toDataURL() };
    }
    return { success: false, error: 'No screen found' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-click', async (event, opts) => {
  try {
    const btnName = String(opts.button || 'left').toLowerCase();
    const Btn = btnName === 'right' ? Button.RIGHT : btnName === 'middle' ? Button.MIDDLE : Button.LEFT;
    await mouse.setPosition(new Point(opts.x, opts.y));
    await new Promise(r => setTimeout(r, 60));
    if (opts.double) {
      await mouse.doubleClick(Btn);
    } else {
      await mouse.click(Btn);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-hotkey', async (event, { keys }) => {
  try {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { success: false, error: "desktop_hotkey requires a non-empty 'keys' array" };
    }
    await keyboard.pressKey(...keys.map(resolveNutKey));
    await keyboard.releaseKey(...keys.map(resolveNutKey));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-drag', async (event, { fromX, fromY, toX, toY }) => {
  try {
    await mouse.setPosition(new Point(fromX, fromY));
    await new Promise(r => setTimeout(r, 100));
    await mouse.pressButton(Button.LEFT);
    const steps = 15;
    for (let i = 1; i <= steps; i++) {
      await mouse.setPosition(new Point(
        Math.round(fromX + (toX - fromX) * i / steps),
        Math.round(fromY + (toY - fromY) * i / steps)
      ));
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 100));
    await mouse.releaseButton(Button.LEFT);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-type', async (event, { text }) => {
  try {
    await keyboard.type(text);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('view-file', async (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('list-dir', async (event, dirPath) => {
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = items.map(item => ({
      name: item.name,
      isDir: item.isDirectory(),
      sizeBytes: item.isFile() ? fs.statSync(path.join(dirPath, item.name)).size.toString() : undefined
    }));
    return { success: true, items: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-to-file', async (event, options) => {
  try {
    const { targetFile, codeContent, overwrite } = options;
    if (fs.existsSync(targetFile) && !overwrite) {
      return { success: false, error: 'File already exists and overwrite is false' };
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, codeContent, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('replace-file-content', async (event, options) => {
  try {
    const { targetFile, targetContent, replacementContent } = options;
    let content = fs.readFileSync(targetFile, 'utf-8');
    if (!content.includes(targetContent)) {
      return { success: false, error: 'Target content not found in file' };
    }
    content = content.replace(targetContent, replacementContent);
    fs.writeFileSync(targetFile, content, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-send-input-event', async (event, { webContentsId, type, x, y, button, clickCount, modifiers, keyCode }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.sendInputEvent({ type, x, y, button, clickCount, modifiers, keyCode });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-insert-text', async (event, { webContentsId, text }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.insertText(text);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Captures only the agent browser webview page (used by browser_screenshot).
ipcMain.handle('browser-capture', async (event, webContentsId) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    let image;
    try {
      image = await wc.capturePage();
    } catch (captureErr: any) {
      // UnknownVizError occurs when the page is blank, not yet rendered, or GPU
      // cache is broken.  Retry once after a short delay; if that also fails,
      // return a 1×1 transparent placeholder so the agent can continue.
      if (captureErr?.message?.includes('UnknownVizError') || captureErr?.name === 'UnknownVizError') {
        await new Promise(r => setTimeout(r, 200));
        try {
          image = await wc.capturePage();
        } catch {
          image = nativeImage.createEmpty();
        }
      } else {
        throw captureErr;
      }
    }
    return { success: true, image: image.toDataURL() };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-emulate-device', async (event, webContentsId, options) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.enableDeviceEmulation(options);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('run-command', async (event, { command, cwd, timeoutMs }) => {
  return new Promise((resolve) => {
    exec(command, {
      cwd: cwd || process.cwd(),
      timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({ success: !error, stdout, stderr, error: error?.message });
    });
  });
});

// Generic web search proxy: forwards { query, limit } to the user-configured
// endpoint with a Bearer token and passes the response back to the agent.
ipcMain.handle('search-web', async (event, { endpoint, apiKey, query, limit = 5 }) => {
  if (!endpoint || !endpoint.trim()) {
    return { success: false, error: 'No search endpoint configured' };
  }
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey && apiKey.trim()) {
      headers['Authorization'] = 'Bearer ' + apiKey.trim();
    }
    const response = await fetch(endpoint.trim(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, limit })
    });
    const text = await response.text();
    if (!response.ok) {
      return { success: false, error: `Search endpoint returned ${response.status}: ${text.substring(0, 500)}` };
    }
    return { success: true, results: text };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Recursive content search across a directory tree (the agent's `search_files`).
ipcMain.handle('grep-search', async (event, { query, path: rootDir, isRegex, maxResults }) => {
  try {
    if (!query || !String(query).trim()) return { success: false, error: 'Empty query' };
    const root = rootDir && String(rootDir).trim() ? path.resolve(String(rootDir)) : process.cwd();
    if (!fs.existsSync(root)) return { success: false, error: `Path not found: ${root}` };

    let rx: RegExp | null = null;
    let needle = '';
    if (isRegex) {
      try { rx = new RegExp(query, 'i'); } catch (e: any) { return { success: false, error: 'Invalid regex: ' + e.message }; }
    } else {
      needle = String(query).toLowerCase();
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'out', 'build', '.next', 'coverage', '__pycache__', '.venv']);
    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    const cap = Math.min(Math.max(Number(maxResults) || 200, 1), 1000);
    const matches: any[] = [];
    let filesScanned = 0;

    const walk = (dir: string, depth: number): void => {
      if (depth > 12 || matches.length >= cap || filesScanned > 8000) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (matches.length >= cap) return;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) walk(full, depth + 1);
          continue;
        }
        if (!ent.isFile()) continue;
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
        let content: string;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (content.includes('\u0000')) continue; // binary file
        filesScanned++;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const hit = rx ? rx.test(lines[i]) : lines[i].toLowerCase().includes(needle);
          if (hit) {
            matches.push({ file: full, lineNumber: i + 1, line: lines[i].slice(0, 300) });
            if (matches.length >= cap) return;
          }
        }
      }
    };

    walk(root, 0);
    return { success: true, matches, truncated: matches.length >= cap || undefined, scannedFiles: filesScanned };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Cookie inspection/management for the agent browser session.
ipcMain.handle('browser-cookies', async (event, { webContentsId, op = 'get', name, value, domain, url, expirationDate }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    const cookies = wc.session.cookies;

    if (op === 'get') {
      const filter: any = {};
      if (name) filter.name = name;
      if (domain) filter.domain = domain;
      const list = await cookies.get(filter);
      return {
        success: true,
        count: list.length,
        cookies: list.slice(0, 150).map(c => ({
          name: c.name,
          value: c.value.length > 120 ? c.value.slice(0, 120) + '…' : c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate
        }))
      };
    }

    if (op === 'set') {
      if (!name) return { success: false, error: "Cookie set requires 'name'" };
      const cookieUrl = url || (domain ? `https://${domain.replace(/^\./, '')}` : wc.getURL());
      await cookies.set({
        url: cookieUrl,
        name,
        value: value ?? '',
        domain: domain || undefined,
        expirationDate: expirationDate ? Number(expirationDate) : undefined,
        secure: cookieUrl.startsWith('https')
      });
      return { success: true, set: name };
    }

    if (op === 'delete') {
      if (!name) return { success: false, error: "Cookie delete requires 'name'" };
      const list = await cookies.get({ name });
      for (const c of list) {
        await cookies.remove(`http${c.secure ? 's' : ''}://${(c.domain || '').replace(/^\./, '')}${c.path}`, name);
      }
      return { success: true, removed: list.length };
    }

    if (op === 'clear') {
      const list = await cookies.get({});
      for (const c of list) {
        await cookies.remove(`http${c.secure ? 's' : ''}://${(c.domain || '').replace(/^\./, '')}${c.path}`, c.name);
      }
      return { success: true, removed: list.length };
    }

    return { success: false, error: `Unknown op "${op}"` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Navigation history of the embedded browser.
ipcMain.handle('browser-history', async (event, { webContentsId, op = 'list', index }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    const nav = (wc as any).navigationHistory;

    if (op === 'list') {
      const entries = nav.getAllEntries();
      const activeIndex = nav.getActiveIndex();
      return {
        success: true,
        activeIndex,
        entries: entries.map((e: any, i: number) => ({ index: i, url: e.url, title: e.title, active: i === activeIndex }))
      };
    }
    if (op === 'back') { wc.goBack(); return { success: true, moved: 'back' }; }
    if (op === 'forward') { wc.goForward(); return { success: true, moved: 'forward' }; }
    if (op === 'goto_index') {
      const idx = Number(index);
      if (!Number.isInteger(idx)) return { success: false, error: "goto_index requires numeric 'index'" };
      nav.restore?.(idx);
      return { success: true, movedToIndex: idx };
    }
    return { success: false, error: `Unknown op "${op}"` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Native find-in-page with match counting and viewport highlight.
ipcMain.handle('find-in-page', async (event, { webContentsId, text, forward = true }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    if (!text) return { success: false, error: "find_in_page requires 'text'" };
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ success: false, error: 'find timed out' }), 4000);
      wc.once('found-in-page' as any, (_e: any, result: any) => {
        clearTimeout(timer);
        resolve({ success: true, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal });
      });
      wc.findInPage(text, { forward: forward !== false });
    });
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// ─── Chromium CDP (external browser) ────────────────────────────────────────
ipcMain.handle('dialog-show-open', async (_e, opts) => {
  try {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
    const res = await dialog.showOpenDialog(win as any, opts);
    return res;
  } catch (e: any) { return { canceled: true, filePaths: [], error: e?.message }; }
});

ipcMain.handle('chrome-launch', async (_e, opts: { chromiumPath?: string; cdpPort?: number; launchArgs?: string; shortcutPath?: string }) => {
  try {
    const mod: any = await import('./browser/launcher.js');
    const r = await mod.launchChromium(opts || {});
    return r;
  } catch (e: any) { return { success:false, error: e?.message || String(e) }; }
});
ipcMain.handle('chrome-force-relaunch', async (_e, opts: { chromiumPath?: string; cdpPort?: number; launchArgs?: string }) => {
  try {
    const mod: any = await import('./browser/launcher.js');
    const r = await mod.killAndRelaunch(opts || {});
    return r;
  } catch (e: any) { return { success:false, error: e?.message || String(e) }; }
});
ipcMain.handle('chrome-status', async (_e, port?: number) => {
  try {
    const mod: any = await import('./browser/launcher.js');
    const p = Number(port) > 0 ? Number(port) : 9222;
    return await mod.chromeStatus(p);
  } catch (e: any) { return { listening:false, error:e?.message }; }
});
ipcMain.handle('chrome-list-targets', async (_e, port?: number) => {
  try {
    const mod: any = await import('./browser/launcher.js');
    const p = Number(port) > 0 ? Number(port) : 9222;
    const list = await mod.chromeListTargets(p);
    return { success:true, targets:list };
  } catch (e: any) { return { success:false, error:e?.message }; }
});
ipcMain.handle('cdp-new-target', async (_e, opts: { port?: number; url?: string }) => {
  try {
    const mod: any = await import('./browser/cdp.js');
    const p = Number(opts?.port) > 0 ? Number(opts.port) : 9222;
    const t = await mod.cdpNewTarget(p, opts?.url || 'about:blank');
    return { success:true, target:t };
  } catch (e: any) { return { success:false, error:e?.message }; }
});
ipcMain.handle('cdp-close-target', async (_e, opts: { port?: number; targetId: string }) => {
  try {
    const mod: any = await import('./browser/cdp.js');
    const p = Number(opts?.port) > 0 ? Number(opts.port) : 9222;
    await mod.cdpCloseTarget(p, opts.targetId);
    mod.closeSession(opts.targetId);
    return { success:true };
  } catch (e: any) { return { success:false, error:e?.message }; }
});
// Generic CDP command — used by renderer to drive live-profile targets.
// Each tool call is a CDP Target; Input/Page/Runtime/Storage domains map 1:1
// to old browser-send-input-event / browser-capture / cookies handlers.
// Screenshots: Page.captureScreenshot; Cursor: Input.dispatchMouseEvent;
// Typing: Input.insertText; Navigation: Page.navigate; Evaluate: Runtime.evaluate.
ipcMain.handle('cdp-command', async (_e, opts: { port?: number; targetId: string; wsUrl?: string; method: string; params?: any }) => {
  try {
    const mod: any = await import('./browser/cdp.js');
    const p = Number(opts?.port) > 0 ? Number(opts.port) : 9222;
    let wsUrl = (opts as any).wsUrl || opts.wsUrl;
    if (!wsUrl) wsUrl = await mod.resolveWsUrl(p, opts.targetId);
    const result = await mod.genericCdpSend(wsUrl, opts.targetId, opts.method, opts.params);
    return { success:true, result };
  } catch (e: any) { return { success:false, error:e?.message }; }
});

// Downloads a URL through the agent browser session, waiting for completion.
ipcMain.handle('browser-download', async (event, { webContentsId, url, savePath }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    if (!url) return { success: false, error: "browser_download requires 'url'" };

    return await new Promise((resolve) => {
      const session = wc.session;
      const timer = setTimeout(() => {
        cleanup();
        resolve({ success: false, error: 'Download timed out after 180s' });
      }, 180000);

      const handler = (_e: any, item: any) => {
        try {
          const targetPath = savePath || path.join(app.getPath('downloads'), item.getFilename());
          item.setSavePath(targetPath);
          item.once('done', (_e2: any, state: string) => {
            cleanup();
            resolve({
              success: state === 'completed',
              state,
              path: item.getSavePath(),
              filename: item.getFilename()
            });
          });
        } catch (err: any) {
          cleanup();
          resolve({ success: false, error: err.message });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        session.removeListener('will-download', handler);
      };

      session.on('will-download', handler);
      wc.downloadURL(url);
    });
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Reports which models are resident in local provider memory (VRAM / load
// state). Ollama exposes /api/ps; LM Studio has its v0 REST API. Cloud
// providers are metered by tokens — nothing to report.
ipcMain.handle('provider-status', async (event, { providers }) => {
  const status: Record<string, any> = {};

  await Promise.all((providers || []).map(async (p: any) => {
    try {
      if (p.id === 'ollama') {
        const base = p.endpoint.replace(/\/v1\/?$/, '');
        const res = await fetch(`${base}/api/ps`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        status[p.id] = {
          kind: 'vram',
          summary: `${data.models?.length || 0} model(s) in memory`,
          models: (data.models || []).map((m: any) => ({
            id: m.name,
            sizeBytes: m.size,
            vramBytes: m.size_vram,
            expiresAt: m.expires_at
          }))
        };
      } else if (p.id === 'lmstudio') {
        const base = p.endpoint.replace(/\/v1\/?$/, '');
        const res = await fetch(`${base}/api/v0/models`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const loaded = (data.data || []).filter((m: any) => m.state === 'loaded');
        status[p.id] = {
          kind: 'load-state',
          summary: `${loaded.length}/${data.data?.length || 0} model(s) loaded`,
          models: loaded.map((m: any) => ({ id: m.id, maxContextLength: m.max_context_length }))
        };
      } else {
        status[p.id] = { kind: 'cloud', summary: 'Token-metered API — no memory stats' };
      }
    } catch (err: any) {
      status[p.id] = { kind: 'unavailable', summary: `Status unavailable: ${err.message}` };
    }
  }));

  return { success: true, status };
});

// ─── Chat history persistence ────────────────────────────────────────────────
// Layout under <userData>/chats/:
//   index.json                    — metadata array (id, parentId, title, …)
//   <chatId>/messages.json        — { version, meta, messages }
//   <chatId>/assets/<hash>.<ext>  — images/screenshots extracted from data URLs
// Flat history: parentId is always null; delete is non-cascading.

const chatsDir = () => path.join(app.getPath('userData'), 'chats');

const chatDirOf = (chatId: string) => {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(chatId)) throw new Error('Invalid chat id');
  return path.join(chatsDir(), chatId);
};

const assetsDirOf = (chatId: string) => path.join(chatDirOf(chatId), 'assets');
const messagesFileOf = (chatId: string) => path.join(chatDirOf(chatId), 'messages.json');
const indexFile = () => path.join(chatsDir(), 'index.json');

// Serialize all storage mutations so concurrent saves never interleave.
let storeQueue: Promise<any> = Promise.resolve();
const serialize = <T,>(fn: () => T | Promise<T>): Promise<T> => {
  const run = storeQueue.then(fn as any, fn as any) as Promise<T>;
  storeQueue = run.catch(() => {});
  return run;
};

const readJson = async (filePath: string): Promise<any> => {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const writeJsonAtomic = async (filePath: string, data: any) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  await fs.promises.rename(tmp, filePath);
};

// Rebuild the index by scanning chat folders (missing/corrupt index fallback).
const rebuildIndex = async (): Promise<any[]> => {
  await fs.promises.mkdir(chatsDir(), { recursive: true });
  const entries = await fs.promises.readdir(chatsDir(), { withFileTypes: true });
  const metas: any[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = await readJson(messagesFileOf(e.name));
    if (file?.meta?.id === e.name) metas.push(file.meta);
  }
  await writeJsonAtomic(indexFile(), metas);
  return metas;
};

const loadIndex = async (): Promise<any[]> => {
  const idx = await readJson(indexFile());
  if (Array.isArray(idx)) return idx;
  return rebuildIndex();
};

const saveIndex = (metas: any[]) => writeJsonAtomic(indexFile(), metas);

// Recursively walk a message payload, extracting every inline data URL into
// an asset file. Returns a deep copy with `chat-asset://<chatId>/<file>` refs.
const DATA_URL_RE = /^data:([\w+.-]+\/[\w+.-]+)?(;base64)?,([\s\S]+)$/;
const extractAssets = async (value: any, chatId: string, depth = 0): Promise<any> => {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    const m = DATA_URL_RE.exec(value);
    // Only hoist substantial binary payloads; tiny data URLs stay inline.
    if (!m || !m[2] || value.length < 4096) return value;
    const extMap: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'image/gif': 'gif', 'image/svg+xml': 'svg'
    };
    const mime = m[1] || 'application/octet-stream';
    const ext = extMap[mime] || 'bin';
    let buf: Buffer;
    try { buf = Buffer.from(m[3], 'base64'); } catch { return value; }
    if (buf.length === 0) return value;
    const name = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
    const filePath = path.join(assetsDirOf(chatId), name);
    try {
      await fs.promises.mkdir(assetsDirOf(chatId), { recursive: true });
      await fs.promises.writeFile(filePath, buf);
    } catch {
      return value; // keep the inline URL if the disk write fails
    }
    return `chat-asset://${chatId}/${name}`;
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = await extractAssets(value[i], chatId, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const k of Object.keys(value)) out[k] = await extractAssets(value[k], chatId, depth + 1);
    return out;
  }
  return value;
};

ipcMain.handle('chats-list', async () => {
  try {
    return { success: true, chats: await serialize(loadIndex) };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e), chats: [] };
  }
});

ipcMain.handle('chats-load', async (_e, chatId: string) => {
  try {
    const file = await serialize(() => readJson(messagesFileOf(chatId)));
    if (!file) throw new Error('Chat not found');
    return { success: true, file };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-save', async (_e, chatId: string, payload: { meta?: any; messages?: any[]; tasks?: any[] }) => {
  try {
    return {
      success: true,
      file: await serialize(async () => {
        const idxBefore = await loadIndex();
        const known = idxBefore.some((m: any) => m.id === chatId);
        const existing = await readJson(messagesFileOf(chatId));
        if (!known && !existing) throw new Error('Chat no longer exists');
        const now = Date.now();
        const meta = {
          ...existing?.meta,
          ...(payload.meta || {}),
          id: chatId,
          updatedAt: now
        };
        const messages = payload.messages !== undefined
          ? await extractAssets(payload.messages, chatId)
          : (existing?.messages ?? []);
        // Tasks are persisted per-chat alongside messages; not injected into LLM context.
        const tasks = payload.tasks !== undefined ? payload.tasks : (existing?.tasks ?? []);
        const file = { version: 1 as const, meta, messages, tasks };
        await writeJsonAtomic(messagesFileOf(chatId), file);
        const idx = await loadIndex();
        const i = idx.findIndex((m: any) => m.id === chatId);
        if (i >= 0) idx[i] = meta; else idx.push(meta);
        await saveIndex(idx);
        return file;
      })
    };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-create', async (_e, spec: { parentId?: string | null; title?: string }) => {
  try {
    const meta = await serialize(async () => {
      const gen = () => 'chat-' + crypto.randomBytes(6).toString('hex');
      let id = gen();
      while (fs.existsSync(chatDirOf(id))) id = gen();
      const now = Date.now();
      const m: any = {
        id,
        parentId: spec.parentId ?? null,
        title: spec.title || 'New Chat',
        createdAt: now,
        updatedAt: now
      };
      await writeJsonAtomic(messagesFileOf(id), { version: 1, meta: m, messages: [], tasks: [] });
      const idx = await loadIndex();
      idx.push(m);
      await saveIndex(idx);
      return m;
    });
    return { success: true, meta };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-rename', async (_e, chatId: string, title: string) => {
  try {
    const clean = String(title || '').trim().slice(0, 120) || 'Untitled';
    const meta = await serialize(async () => {
      const idx = await loadIndex();
      const entry = idx.find((m: any) => m.id === chatId);
      if (!entry) throw new Error('Chat not found');
      entry.title = clean;
      entry.updatedAt = Date.now();
      await saveIndex(idx);
      return entry;
    });
    const file = await readJson(messagesFileOf(chatId));
    if (file) {
      file.meta = { ...file.meta, title: clean, updatedAt: meta.updatedAt };
      await writeJsonAtomic(messagesFileOf(chatId), file);
    }
    return { success: true, meta };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-delete', async (_e, chatId: string) => {
  try {
    await serialize(async () => {
      await fs.promises.rm(chatDirOf(chatId), { recursive: true, force: true });
      const idx = (await loadIndex()).filter((m: any) => m.id !== chatId);
      await saveIndex(idx);
    });
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-export-zip', async (event, chatId: string) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const idx = await loadIndex();
    const root = idx.find((m: any) => m.id === chatId);
    if (!root) throw new Error('Chat not found');

    const usedNames = new Set<string>();
    const folderName = (meta: any) => {
      const base = (meta.title || 'chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'chat';
      let name = base, n = 2;
      while (usedNames.has(name.toLowerCase())) name = `${base} (${n++})`;
      usedNames.add(name.toLowerCase());
      return name;
    };

    const zip = new AdmZip();
    const file = await readJson(messagesFileOf(chatId));
    const assets = assetsDirOf(chatId);
    const zipPath = folderName(root);
    if (file) zip.addFile(path.posix.join(zipPath, 'messages.json'), Buffer.from(JSON.stringify(file, null, 2)));
    if (fs.existsSync(assets)) zip.addLocalFolder(assets, path.posix.join(zipPath, 'assets'));

    const safeTitle = (root.title || 'chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'chat';
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: 'Export chat',
      defaultPath: path.join(app.getPath('downloads'), `${safeTitle}.zip`),
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    zip.writeZip(filePath);
    shell.showItemInFolder(filePath);
    return { success: true, path: filePath };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// Serve extracted chat assets to the renderer over chat-asset://<chatId>/<file>.
app.whenReady().then(() => {
  protocol.handle('chat-asset', (request) => {
    try {
      const url = new URL(request.url);
      const chatId = url.hostname;
      const fileName = decodeURIComponent(url.pathname.slice(1));
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(chatId) || !/^[\w][\w.-]*$/.test(fileName)) {
        return new Response('Bad request', { status: 400 });
      }
      return net.fetch(pathToFileURL(path.join(assetsDirOf(chatId), fileName)).toString());
    } catch (e: any) {
      return new Response(`Not found: ${e?.message || e}`, { status: 404 });
    }
  });
});

// Electron logs every failed guest/webview navigation through process.emitWarning.
// Suppress that spam (ad trackers etc.) while preserving other warnings.
const origEmitWarning = process.emitWarning.bind(process);
(process as any).emitWarning = (warning: any, ...rest: any[]) => {
  try {
    const msg = typeof warning === 'string' ? warning : String(warning?.message ?? warning ?? '');
    if (msg.includes('Failed to load URL')) return;
  } catch {}
  return origEmitWarning(warning, ...rest);
};

app.on('web-contents-created', (event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      contents.loadURL(url);
      return { action: 'deny' };
    });
    // Handle did-fail-load so Electron doesn't spam the console with
    // "Failed to load URL ... ERR_BLOCKED_BY_RESPONSE / ERR_TOO_MANY_REDIRECTS"
    // for every blocked tracker/ad subframe on ad-heavy pages.
    contents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 = ERR_ABORTED: navigation superseded, expected during rapid driving
      if (code === -3) return;
      console.warn(`[AgentBrowser] load failed (${code} ${desc}): ${url}`);
    });
  }
});

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
