import { app, BrowserWindow, BaseWindow, WebContentsView, session, ipcMain, nativeImage, shell, desktopCapturer, screen, webContents, dialog, protocol, net, Menu } from 'electron';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import AdmZip from 'adm-zip';
import * as officeParser from 'officeparser';
import { BrowserShared } from './browser/Browser.js';

// chat-asset:// must be registered as privileged before app ready so the
// renderer can load local images through it over both http (dev) and file (prod).
protocol.registerSchemesAsPrivileged([
  { scheme: 'chat-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);


let mainWindow: BaseWindow | null = null;
let reactView: WebContentsView | null = null;
const agentViews = new Map<string, WebContentsView>(); // legacy single-view path — kept for compat, but new code uses Browser
let activeAgentViewId: string | null = null;
let extensionsManager: ElectronChromeExtensions | null = null;

// ─── Encapsulated shared browser core — one session/extensions, many instantiable browsers ───
const browserShared = new BrowserShared();

// Back-compat aliases — deprecated direct maps now delegate to BrowserShared instances
// They keep old global names working for any leftover references while the true state lives in BrowserShared
const browserTabs = new Map<string, Map<string, WebContentsView>>(); // deprecated — use browserShared.getOrCreate(id).tabs
const browserTabMeta = new Map<string, any>();
const activeTabForAgent = new Map<string, string>();
const lastBrowserBoundsForAgent = new Map<string, { x: number; y: number; width: number; height: number }>();
const lastActiveAt = new Map<string, number>();
const suspendTimers = new Map<string, NodeJS.Timeout>();
const AUTO_SUSPEND_MS = 5 * 60 * 1000;
const tabKey = (agentId: string, tabId: string) => `${agentId}::${tabId}`;
const getAgentTabs = (agentId: string) => browserShared.getOrCreate(agentId).tabs as any;
const emitTabUpdate = (agentId: string, tabId: string) => {
  const b = browserShared.get(agentId);
  const m = b?.meta.get(`${agentId}::${tabId}`);
  if (m) browserShared.emitTabUpdate(agentId, tabId, m as any);
};
const scheduleAutoSuspend = (agentId: string, tabId: string) => browserShared.getOrCreate(agentId).tabs.has(tabId) && (browserShared.get(agentId) as any)?.['scheduleAutoSuspend']?.(tabId);
const cancelAutoSuspend = (agentId: string, tabId: string) => { try { (browserShared.get(agentId) as any)?.['cancelAutoSuspend']?.(tabId); } catch {} };
const attachTabEvents = (view: WebContentsView, agentId: string, tabId: string) => {
  // deprecated — Browser instances handle their own events; no-op for compat
};

const createWindow = () => {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

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

  // Encapsulated core init — single session/extensions shared by every Browser instance
  browserShared.init(mainWindow, reactView);
  extensionsManager = browserShared.extensionsManager;

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
      if (err?.message?.includes('ERR_ABORTED') || err?.code === -3) return;
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

  // Encapsulated path — every browser (take-control & standalone) is now a Browser instance with identical core abilities
  // Hide previously visible browser (if any) — whether it was another Browser instance or legacy agentViews
  if (browserShared.activeBrowserId && browserShared.activeBrowserId !== id) {
    try { browserShared.getOrCreate(browserShared.activeBrowserId).hide(); } catch {}
    const prevLegacy = agentViews.get(browserShared.activeBrowserId);
    if (prevLegacy) try { mainWindow.contentView.removeChildView(prevLegacy); } catch {}
  }
  // Also hide standalone if it was visible but not marked as activeBrowserId
  if (!browserShared.activeBrowserId || browserShared.activeBrowserId !== id) {
    try { browserShared.getOrCreate('__standalone__').hide(); } catch {}
  }

  const browser = browserShared.getOrCreate(id);
  browserShared.activeBrowserId = id;
  activeAgentViewId = id; // keep legacy var in sync for bounds/update handlers
  if (reactView) try { mainWindow.contentView.addChildView(reactView); } catch {}
  browser.show();

  const activeTab = (browser as any).activeTabId ? (browser as any).tabs.get((browser as any).activeTabId) : null;
  return { success: true, webContentsId: activeTab?.webContents.id || null };
});

ipcMain.handle('return-to-chat', async () => {
  if (!mainWindow) return { success: false };
  // Unified hide — works for both Browser instances and legacy single view
  if (browserShared.activeBrowserId) {
    try { browserShared.getOrCreate(browserShared.activeBrowserId).hide(); } catch {}
  } else if (activeAgentViewId) {
    const b = browserShared.get(activeAgentViewId);
    if (b) try { b.hide(); } catch {}
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
  browserShared.activeBrowserId = null;
  activeAgentViewId = null;
  return { success: true };
});
ipcMain.handle('browser-update-bounds', (event, bounds) => {
  // Unified — single Browser core, per-instance bounds stored in each Browser
  const activeId = browserShared.activeBrowserId || activeAgentViewId || '__standalone__';
  try { browserShared.getOrCreate(activeId).updateBounds(bounds); } catch {}
  try { browserShared.getOrCreate('__standalone__').updateBounds(bounds); } catch {}
  // legacy fallback for any remaining agentViews consumers
  if (activeAgentViewId && agentViews.has(activeAgentViewId)) {
    const view = agentViews.get(activeAgentViewId);
    if (view && !view.webContents.isDestroyed()) try { view.setBounds(bounds); } catch {}
  }
  return { success: true };
});

ipcMain.handle('browser-navigate', (event, url) => {
  const activeId = browserShared.activeBrowserId || activeAgentViewId || '__standalone__';
  const b = browserShared.get(activeId) || browserShared.getOrCreate(activeId);
  // try active Browser instance first (covers both take-control and user-visible)
  try {
    const tid = (b as any).activeTabId;
    if (tid) {
      b.navigate(url);
      return { success: true };
    }
  } catch {}
  // fallback — try standalone if active had no tab
  try {
    const s = browserShared.get('__standalone__');
    if (s && (s as any).activeTabId) { s.navigate(url); return { success: true }; }
  } catch {}
  if (activeAgentViewId && agentViews.has(activeAgentViewId)) {
    const view = agentViews.get(activeAgentViewId);
    if (view && !view.webContents.isDestroyed()) {
      const nav:any = (view.webContents as any).navigationHistory;
      const canGoBack = () => { try{ return nav ? nav.canGoBack() : (view.webContents as any).canGoBack(); }catch{ return false; } };
      const canGoForward = () => { try{ return nav ? nav.canGoForward() : (view.webContents as any).canGoForward(); }catch{ return false; } };
      if (url === 'back') { if (canGoBack()) nav ? nav.goBack() : view.webContents.goBack(); }
      else if (url === 'forward') { if (canGoForward()) nav ? nav.goForward() : view.webContents.goForward(); }
      else if (url === 'reload') view.webContents.reload();
      else if (url === 'stop') view.webContents.stop();
      else view.webContents.loadURL(url).catch(() => {});
    }
  }
  return { success: true };
});

// ─── Browser encapsulation — delegate to BrowserShared (single core, many instances) ───
const ensureTabView = (agentId: string, tabId: string, initialUrl?: string) => {
  // Unified: every caller now goes through the shared Browser core — same session, same extensions, same tab logic
  return browserShared.getOrCreate(agentId).ensureTabView(tabId, initialUrl);
};

ipcMain.handle('browser-create-tab', async (_e, { agentId, tabId, url }) => {
  if (!agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  try { browserShared.getOrCreate(agentId).createTab(tabId, url); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
});

ipcMain.handle('browser-switch-tab', async (_e, { agentId, tabId }) => {
  if (!mainWindow || !agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  try {
    const b = browserShared.getOrCreate(agentId);
    // ensure active browser context matches the switched browser — both take-control and user-visible share same core
    browserShared.activeBrowserId = agentId;
    const res = b.switchTab(tabId);
    return { success: true, webContentsId: res.webContentsId };
  } catch (e: any) { return { success: false, error: e.message }; }
});

ipcMain.handle('browser-close-tab', async (_e, { agentId, tabId }) => {
  if (!agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  try { browserShared.getOrCreate(agentId).closeTab(tabId); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
});

ipcMain.handle('browser-park-tab', async (_e, { agentId, tabId }) => {
  if (!agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  try { browserShared.getOrCreate(agentId).parkTab(tabId); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
});

ipcMain.handle('browser-unpark-tab', async (_e, { agentId, tabId }) => {
  if (!agentId || !tabId) return { success: false, error: 'agentId and tabId required' };
  try { browserShared.getOrCreate(agentId).unparkTab(tabId); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
});

ipcMain.handle('browser-get-tabs', async (_e, { agentId }) => {
  if (!agentId) return { success: false, error: 'agentId required' };
  const b = browserShared.getOrCreate(agentId);
  return { success: true, ...b.getTabs() };
});

// Agents can discover user-created tabs (shared cookies via same persist:oneagent_browser session)
ipcMain.handle('browser-list-all-tabs', async () => {
  const all: any[] = [];
  for (const b of browserShared.allBrowsers()) {
    for (const item of b.listAllTabsForExport()) all.push(item);
  }
  return { success: true, tabs: all };
});
// Let an agent adopt or create a tab in the shared user namespace (__standalone__)
ipcMain.handle('browser-agent-ensure-tab', async (_e, { agentId, url }) => {
  const targetAgent = '__standalone__';
  const b = browserShared.getOrCreate(targetAgent);
  const tabId = `agent-${agentId || 'anon'}-${Date.now()}`;
  const view = b.ensureTabView(tabId, url || 'https://duckduckgo.com');
  (b as any).activeTabId = tabId;
  browserShared.activeBrowserId = targetAgent;
  if (mainWindow && !activeAgentViewId) {
    try { mainWindow.contentView.addChildView(view); } catch {}
    const bounds = (b as any).lastBounds;
    if (bounds) try { view.setBounds(bounds as any); } catch {}
  }
  return { success: true, agentId: targetAgent, tabId, url: view.webContents.getURL(), webContentsId: view.webContents.id };
});

// ─── Standalone browser (shared core — same Browser class, different browserId) ───
ipcMain.handle('standalone-create-tab', async (_e, { tabId, url }) => {
  if (!tabId) return { success: false, error: 'tabId required' };
  try { browserShared.getOrCreate('__standalone__').createTab(tabId, url); return { success: true }; } catch (e: any) { return { success: false, error: e.message }; }
});
ipcMain.handle('standalone-switch-tab', async (_e, { tabId }) => {
  try { browserShared.activeBrowserId = '__standalone__'; const res = browserShared.getOrCreate('__standalone__').switchTab(tabId); return { success: true, webContentsId: res.webContentsId }; } catch (e: any) { return { success: false, error: e.message }; }
});
ipcMain.handle('standalone-get-tabs', async () => {
  const b = browserShared.getOrCreate('__standalone__');
  return { success: true, ...b.getTabs() };
});
ipcMain.handle('standalone-navigate', async (_e, { tabId, url }) => {
  const b = browserShared.getOrCreate('__standalone__');
  const tid = tabId || (b as any).activeTabId;
  if (!tid) return { success: false, error: 'no active standalone tab' };
  const view = (b as any).tabs.get(tid);
  if (!view || view.webContents.isDestroyed()) return { success: false, error: 'view not found' };
  const nav:any = (view.webContents as any).navigationHistory;
  const canGoBack = () => { try{ return nav ? nav.canGoBack() : (view.webContents as any).canGoBack(); }catch{ return false; } };
  const canGoForward = () => { try{ return nav ? nav.canGoForward() : (view.webContents as any).canGoForward(); }catch{ return false; } };
  if (url === 'back') { if (canGoBack()) nav ? nav.goBack() : view.webContents.goBack(); }
  else if (url === 'forward') { if (canGoForward()) nav ? nav.goForward() : view.webContents.goForward(); }
  else if (url === 'reload') view.webContents.reload();
  else if (url === 'stop') view.webContents.stop();
  else view.webContents.loadURL(url).catch(() => {});
  return { success: true };
});
ipcMain.handle('standalone-update-bounds', async (_e, bounds) => {
  const b = browserShared.getOrCreate('__standalone__');
  (b as any).lastBounds = bounds;
  if ((b as any).activeTabId) {
    const view = (b as any).tabs.get((b as any).activeTabId);
    if (view && !view.webContents.isDestroyed() && !activeAgentViewId) {
      try { view.setBounds(bounds); } catch {}
    }
  }
  return { success: true };
});
ipcMain.handle('standalone-enter', async () => {
  if (!mainWindow) return { success: false };
  const curId = browserShared.activeBrowserId;
  if (curId && curId !== '__standalone__') {
    try { browserShared.getOrCreate(curId).hide(); } catch {}
    const legacy = agentViews.get(curId);
    if (legacy) try { mainWindow.contentView.removeChildView(legacy); } catch {}
  }
  const b = browserShared.getOrCreate('__standalone__');
  browserShared.activeBrowserId = '__standalone__';
  activeAgentViewId = '__standalone__';
  if (!(b as any).activeTabId || !((b as any).tabs.has((b as any).activeTabId))) {
    if ((b as any).tabs.size === 0) {
      const tidNew = `tab-${Date.now()}`;
      b.ensureTabView(tidNew, 'https://duckduckgo.com');
      (b as any).activeTabId = tidNew;
    } else {
      (b as any).activeTabId = (b as any).tabs.keys().next().value;
    }
  }
  const tid2 = (b as any).activeTabId as string;
  const view2 = (b as any).tabs.get(tid2)!;
  if (reactView) try { mainWindow.contentView.addChildView(reactView); } catch {}
  try { mainWindow.contentView.addChildView(view2); } catch {}
  const bounds2 = (b as any).lastBounds;
  if (bounds2) try { view2.setBounds(bounds2 as any); } catch {}
  if (browserShared.extensionsManager) try { browserShared.extensionsManager.selectTab(view2.webContents); } catch {}
  return { success: true, tabId: tid2, webContentsId: view2.webContents.id };
});
ipcMain.handle('standalone-leave', async () => {
  if (!mainWindow) return { success: false };
  try { browserShared.getOrCreate('__standalone__').hide(); } catch {}
  browserShared.activeBrowserId = null;
  activeAgentViewId = null;
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
  const b = browserShared.getOrCreate('__standalone__');
  const tid = `tab-${Date.now()}`;
  b.ensureTabView(tid, target);
  (b as any).activeTabId = tid;
  browserShared.activeBrowserId = '__standalone__';
  if (!activeAgentViewId && mainWindow) {
    const view = (b as any).tabs.get(tid)!;
    try { mainWindow.contentView.addChildView(view); } catch {}
    const bounds = (b as any).lastBounds;
    if (bounds) try { view.setBounds(bounds as any); } catch {}
    if (browserShared.extensionsManager) try { browserShared.extensionsManager.selectTab(view.webContents); } catch {}
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
        const [psRes, tagsRes] = await Promise.all([
          fetch(`${base}/api/ps`),
          fetch(`${base}/api/tags`).catch(() => null)
        ]);
        if (!psRes.ok) throw new Error(`HTTP ${psRes.status}`);
        const data = await psRes.json();
        let available: any[] = [];
        if (tagsRes && tagsRes.ok) {
          try {
            const tags = await tagsRes.json();
            available = (tags.models || []).map((m: any) => ({ id: m.name, sizeBytes: m.size }));
          } catch {}
        }
        status[p.id] = {
          kind: 'vram',
          summary: `${data.models?.length || 0} model(s) in memory`,
          models: (data.models || []).map((m: any) => ({
            id: m.name,
            sizeBytes: m.size,
            vramBytes: m.size_vram,
            expiresAt: m.expires_at
          })),
          available
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

// Total system VRAM usage across all GPUs (used/total bytes). Uses
// nvidia-smi when an NVIDIA driver is present; otherwise reports nothing.
ipcMain.handle('vram-usage', async () => {
  try {
    const { execFile } = await import('child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000 } as any, (err: any, stdout: any) => {
        if (err) reject(err); else resolve(String(stdout));
      });
    });
    let usedBytes = 0, totalBytes = 0;
    for (const line of out.trim().split('\n')) {
      const [u, t] = line.split(',').map((s: string) => parseInt(s.trim(), 10));
      if (!isNaN(u) && !isNaN(t)) { usedBytes += u * 1024 * 1024; totalBytes += t * 1024 * 1024; }
    }
    if (totalBytes > 0) return { success: true, usedBytes, totalBytes };
    return { success: false };
  } catch {
    return { success: false };
  }
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

ipcMain.handle('chats-save', async (_e, chatId: string, payload: { meta?: any; messages?: any[]; tasks?: any[]; chatConfig?: any; savedAt?: number; savedAtIso?: string }) => {
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
        const chatConfig = (payload as any).chatConfig !== undefined ? (payload as any).chatConfig : (existing as any)?.chatConfig;
        const savedAt = (payload as any).savedAt ?? now;
        const savedAtIso = (payload as any).savedAtIso ?? new Date(savedAt).toISOString();
        const file: any = { version: 1 as const, meta, messages, tasks, chatConfig, savedAt, savedAtIso };
        // Extract assets from chatConfig if they contain data URLs (e.g. embedded images in future)
        const fileWithAssets = await extractAssets(file, chatId);
        await writeJsonAtomic(messagesFileOf(chatId), fileWithAssets);
        const idx = await loadIndex();
        const i = idx.findIndex((m: any) => m.id === chatId);
        if (i >= 0) idx[i] = meta; else idx.push(meta);
        await saveIndex(idx);
        return fileWithAssets;
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
