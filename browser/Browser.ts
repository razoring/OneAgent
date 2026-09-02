// Shared browser core — single session/extension store, multiple instantiable browsers with identical capabilities
// Each Browser instance (browserId) owns its own tab set but shares cookies/storage/extensions via persist:oneagent_browser

import { WebContentsView, session, Menu, BaseWindow } from 'electron';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';

export type TabMeta = { url: string; title: string; loading: boolean; parked: boolean; favicon?: string; canGoBack?: boolean; canGoForward?: boolean };

const AUTO_SUSPEND_MS = 5 * 60 * 1000;

export class BrowserShared {
  session!: ReturnType<typeof session.fromPartition>;
  extensionsManager: ElectronChromeExtensions | null = null;
  mainWindow: BaseWindow | null = null;
  reactView: WebContentsView | null = null;

  // browserId -> Browser instance
  private browsers = new Map<string, Browser>();

  init(mainWindow: BaseWindow, reactView: WebContentsView) {
    if (!this.session) {
      this.session = session.fromPartition('persist:oneagent_browser');
    }
    this.mainWindow = mainWindow;
    this.reactView = reactView;
    // shared extensions + crx protocol — same core for every instance
    this.extensionsManager = new ElectronChromeExtensions({ session: this.session, license: 'GPL-3.0' });
    try { ElectronChromeExtensions.handleCRXProtocol(this.session); } catch (e) { console.warn('[BrowserShared] handleCRXProtocol failed', e); }
  }

  getSession(): ReturnType<typeof session.fromPartition> {
    if (!this.session) {
      this.session = session.fromPartition('persist:oneagent_browser');
    }
    return this.session;
  }

  getOrCreate(browserId: string): Browser {
    let b = this.browsers.get(browserId);
    if (!b) {
      b = new Browser(browserId, this);
      this.browsers.set(browserId, b);
    }
    return b;
  }

  get(browserId: string): Browser | undefined { return this.browsers.get(browserId); }

  allBrowsers(): IterableIterator<Browser> { return this.browsers.values(); }

  // hide whichever browser is currently visible — used when switching browserId contexts
  activeBrowserId: string | null = null;

  // Utility to emit to renderer (reactView) — single channel for all browsers, includes browserId as agentId for compat
  emitTabUpdate(browserId: string, tabId: string, meta: TabMeta) {
    if (!this.reactView || this.reactView.webContents.isDestroyed()) return;
    this.reactView.webContents.send('browser-tab-updated', { agentId: browserId, tabId, ...meta });
  }
  emitTabClosed(browserId: string, tabId: string) {
    if (!this.reactView || this.reactView.webContents.isDestroyed()) return;
    this.reactView.webContents.send('browser-tab-closed', { agentId: browserId, tabId });
  }
}

export class Browser {
  // per-browser tab state
  tabs = new Map<string, WebContentsView>();
  meta = new Map<string, TabMeta>();
  activeTabId: string | null = null;
  lastBounds: { x: number; y: number; width: number; height: number } | null = null;
  lastActiveAt = new Map<string, number>();
  suspendTimers = new Map<string, NodeJS.Timeout>();

  constructor(public readonly browserId: string, private shared: BrowserShared) {}

  private tabKey(tabId: string) { return `${this.browserId}::${tabId}`; }

  private emit(tabId: string) {
    const m = this.meta.get(this.tabKey(tabId));
    if (m) this.shared.emitTabUpdate(this.browserId, tabId, m);
  }

  private scheduleAutoSuspend(tabId: string) {
    const key = this.tabKey(tabId);
    if (this.suspendTimers.has(key)) clearTimeout(this.suspendTimers.get(key)!);
    if (this.activeTabId === tabId) return;
    const meta = this.meta.get(key);
    if (!meta || meta.parked) return;
    const view = this.tabs.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;
    try { if ((view.webContents as any).isCurrentlyAudible?.()) return; } catch {}
    const timer = setTimeout(() => {
      this.suspendTimers.delete(key);
      const curMeta = this.meta.get(key);
      const curView = this.tabs.get(tabId);
      if (!curMeta || !curView || curView.webContents.isDestroyed()) return;
      if (this.activeTabId === tabId) return;
      try { if ((curView.webContents as any).isCurrentlyAudible?.()) { this.scheduleAutoSuspend(tabId); return; } } catch {}
      curMeta.parked = true;
      try { this.shared.mainWindow?.contentView.removeChildView(curView); } catch {}
      try { (curView.webContents as any).setBackgroundThrottling?.(true); } catch {}
      try { curView.webContents.setAudioMuted(true); } catch {}
      this.emit(tabId);
      console.log(`[Browser:${this.browserId}] auto-suspended ${tabId}`);
    }, AUTO_SUSPEND_MS);
    this.suspendTimers.set(key, timer);
  }

  private cancelAutoSuspend(tabId: string) {
    const key = this.tabKey(tabId);
    const t = this.suspendTimers.get(key);
    if (t) { clearTimeout(t); this.suspendTimers.delete(key); }
  }

  private attachTabEvents(view: WebContentsView, tabId: string) {
    const key = this.tabKey(tabId);
    const updateMeta = (patch: Partial<TabMeta>) => {
      const cur = this.meta.get(key);
      if (!cur) return;
      Object.assign(cur, patch);
      try {
        const nav: any = (view.webContents as any).navigationHistory;
        if (nav) { cur.canGoBack = nav.canGoBack(); cur.canGoForward = nav.canGoForward(); }
        else { cur.canGoBack = (view.webContents as any).canGoBack(); cur.canGoForward = (view.webContents as any).canGoForward(); }
      } catch {}
      this.emit(tabId);
    };
    const touchActive = () => {
      this.lastActiveAt.set(key, Date.now());
      this.cancelAutoSuspend(tabId);
      for (const [tid] of this.tabs) if (tid !== tabId) this.scheduleAutoSuspend(tid);
    };
    view.webContents.on('did-start-loading', () => { updateMeta({ loading: true }); touchActive(); });
    view.webContents.on('did-stop-loading', () => { updateMeta({ loading: false, title: view.webContents.getTitle() || curTitle(), url: view.webContents.getURL() }); touchActive(); });
    view.webContents.on('did-navigate', (_e: any, url: string) => { updateMeta({ url }); touchActive(); });
    view.webContents.on('did-navigate-in-page', (_e: any, url: string) => { updateMeta({ url }); touchActive(); });
    view.webContents.on('did-redirect-navigation' as any, (_e: any, url: string) => { updateMeta({ url }); touchActive(); });
    view.webContents.on('page-title-updated', (_e: any, title: string) => updateMeta({ title }));
    view.webContents.on('page-favicon-updated', (_e: any, favicons: string[]) => { if (favicons?.[0]) updateMeta({ favicon: favicons[0] }); });
    view.webContents.on('did-fail-load', (_e: any, code: number, _desc: string, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame || code === -3) return;
      updateMeta({ loading: false });
    });
    const curTitle = () => view.webContents.getTitle() || this.meta.get(key)?.title || 'New Tab';
  }

  ensureTabView(tabId: string, initialUrl?: string): WebContentsView {
    let view = this.tabs.get(tabId);
    if (view && !view.webContents.isDestroyed()) return view;

    view = new WebContentsView({
      webPreferences: { session: this.shared.getSession(), contextIsolation: true, nodeIntegration: false }
    });

    view.webContents.on('before-input-event', (_e: any, input: any) => {
      if (input.type === 'keyDown' && input.key === 'F12') { try { view!.webContents.toggleDevTools(); } catch {} }
    });

    try { view.webContents.removeAllListeners('context-menu'); } catch {}
    view.webContents.on('context-menu', (_: any, params: any) => {
      if (!view || view.webContents.isDestroyed()) return;
      try {
        const template: any[] = [
          { label: 'Back', enabled: (()=>{ try{ const n:any=(view.webContents as any).navigationHistory; return n? n.canGoBack() : (view.webContents as any).canGoBack(); }catch{ return false; }})(), click: () => { try { if (!view!.webContents.isDestroyed()) (view.webContents as any).navigationHistory ? (view.webContents as any).navigationHistory.goBack() : view.webContents.goBack(); } catch {} } },
          { label: 'Forward', enabled: (()=>{ try{ const n:any=(view.webContents as any).navigationHistory; return n? n.canGoForward() : (view.webContents as any).canGoForward(); }catch{ return false; }})(), click: () => { try { if (!view!.webContents.isDestroyed()) (view.webContents as any).navigationHistory ? (view.webContents as any).navigationHistory.goForward() : view.webContents.goForward(); } catch {} } },
          { label: 'Reload', click: () => { try { if (!view!.webContents.isDestroyed()) view!.webContents.reload(); } catch {} } },
          { type: 'separator' } as any,
        ];
        if (params.linkURL) {
          template.push(
            { label: 'Open Link in New Tab', click: () => { const nid = `tab-${Date.now()}`; try { this.ensureTabView(nid, params.linkURL); } catch {} } },
            { label: 'Copy Link Address', click: () => { try { require('electron').clipboard.writeText(params.linkURL); } catch {} } },
            { type: 'separator' } as any,
          );
        }
        if (params.srcURL) {
          template.push(
            { label: 'Copy Image Address', click: () => { try { require('electron').clipboard.writeText(params.srcURL); } catch {} } },
            { label: 'Save Image As…', click: () => { try { view!.webContents.downloadURL(params.srcURL); } catch {} } },
            { type: 'separator' } as any,
          );
        }
        if (params.selectionText) {
          template.push(
            { label: `Search for “${params.selectionText.slice(0, 30)}”`, click: () => { const nid = `tab-${Date.now()}`; try { this.ensureTabView(nid, `https://duckduckgo.com/?q=${encodeURIComponent(params.selectionText)}`); } catch {} } },
            { type: 'separator' } as any,
          );
        }
        template.push(
          { label: 'Copy', role: 'copy' } as any,
          { label: 'Paste', role: 'paste' } as any,
          { label: 'Cut', role: 'cut' } as any,
          { label: 'Select All', role: 'selectAll' } as any,
          { type: 'separator' } as any,
          { label: 'View Page Source', click: () => { try { const u = view!.webContents.getURL(); const nid = `tab-${Date.now()}`; this.ensureTabView(nid, `view-source:${u}`); } catch {} } } as any,
          { label: 'Save As…', click: () => { try { view!.webContents.downloadURL(view!.webContents.getURL()); } catch {} } } as any,
          { label: 'Print…', click: () => { try { view!.webContents.print({}); } catch {} } } as any,
          { type: 'separator' } as any,
          { label: 'Inspect Element', click: () => { try { if (!view!.webContents.isDestroyed()) view!.webContents.inspectElement(params.x, params.y); } catch {} } } as any,
        );
        try {
          const extItems = this.shared.extensionsManager?.getContextMenuItems(view!.webContents as any, params as any) as any[];
          if (extItems?.length) template.splice(template.length - 2, 0, { type: 'separator' } as any, ...extItems);
        } catch {}
        const menu = Menu.buildFromTemplate(template);
        try { (menu as any).popup({ window: this.shared.mainWindow! }); } catch { menu.popup(); }
      } catch (e) { console.error('[Browser] context-menu failed', e); }
    });

    this.meta.set(this.tabKey(tabId), { url: initialUrl || 'https://duckduckgo.com', title: 'New Tab', loading: false, parked: false });
    this.attachTabEvents(view, tabId);
    this.tabs.set(tabId, view);

    try {
      view.webContents.setWindowOpenHandler(({ url }) => {
        try {
          const nid = `tab-${Date.now()}`;
          this.ensureTabView(nid, url);
          if (this.activeTabId && this.shared.activeBrowserId === this.browserId) {
            setTimeout(() => {
              const v2 = this.tabs.get(nid);
              if (v2 && this.shared.mainWindow && !v2.webContents.isDestroyed()) {
                const prev = this.activeTabId;
                if (prev && prev !== nid) {
                  const pv = this.tabs.get(prev);
                  if (pv) try { this.shared.mainWindow!.contentView.removeChildView(pv); } catch {}
                }
                this.activeTabId = nid;
                try { this.shared.mainWindow!.contentView.addChildView(v2); } catch {}
                const b = this.lastBounds;
                if (b) try { v2.setBounds(b as any); } catch {}
                try { (v2.webContents as any).setBackgroundThrottling?.(false); } catch {}
                if (this.shared.extensionsManager) try { this.shared.extensionsManager.selectTab(v2.webContents); } catch {}
                this.emit(nid);
                if (prev) this.emit(prev);
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
  }

  // Public API — identical for every browser instance
  createTab(tabId: string, url?: string) { this.ensureTabView(tabId, url); }

  switchTab(tabId: string): { webContentsId: number } {
    let view = this.tabs.get(tabId);
    if (!view || view.webContents.isDestroyed()) {
      const meta = this.meta.get(this.tabKey(tabId));
      if (meta?.parked) { try { meta.parked = false; this.emit(tabId); } catch {} }
      view = this.ensureTabView(tabId, meta?.url);
    }
    const prevId = this.activeTabId;
    if (prevId && prevId !== tabId) {
      const prevView = this.tabs.get(prevId);
      if (prevView && !prevView.webContents.isDestroyed()) {
        try { this.shared.mainWindow?.contentView.removeChildView(prevView); } catch {}
        const pm = this.meta.get(this.tabKey(prevId));
        if (pm?.parked) {
          try { (prevView.webContents as any).setBackgroundThrottling?.(true); } catch {}
          try { prevView.webContents.setAudioMuted(true); } catch {}
        } else {
          this.scheduleAutoSuspend(prevId);
        }
      }
    }
    this.activeTabId = tabId;
    this.cancelAutoSuspend(tabId);
    this.lastActiveAt.set(this.tabKey(tabId), Date.now());

    const shouldAttach = this.shared.activeBrowserId === this.browserId;
    if (shouldAttach && this.shared.mainWindow && !view.webContents.isDestroyed()) {
      try { this.shared.mainWindow.contentView.addChildView(view); } catch {}
      if (this.lastBounds) { try { view.setBounds(this.lastBounds as any); } catch {} }
      else if (this.shared.mainWindow) {
        const [w, h] = this.shared.mainWindow.getContentSize();
        try { view.setBounds({ x: 0, y: 0, width: w, height: h } as any); } catch {}
      }
      setTimeout(() => { const b = this.lastBounds; if (b && !view!.webContents.isDestroyed()) try { view!.setBounds(b as any); } catch {} }, 60);
      try { (view.webContents as any).setBackgroundThrottling?.(false); } catch {}
      try { view.webContents.setAudioMuted(false); } catch {}
      if (this.shared.extensionsManager) try { this.shared.extensionsManager.selectTab(view.webContents); } catch {}
    }
    const meta = this.meta.get(this.tabKey(tabId));
    if (meta) { meta.parked = false; }
    this.emit(tabId);
    if (prevId && prevId !== tabId) this.emit(prevId);
    return { webContentsId: view.webContents.id };
  }

  closeTab(tabId: string) {
    const key = this.tabKey(tabId);
    this.cancelAutoSuspend(tabId);
    this.lastActiveAt.delete(key);
    const view = this.tabs.get(tabId);
    if (!view) { this.meta.delete(key); return; }
    if (this.activeTabId === tabId && this.shared.mainWindow) {
      try { this.shared.mainWindow.contentView.removeChildView(view); } catch {}
      this.activeTabId = null;
    }
    if (!view.webContents.isDestroyed()) try { view.webContents.close(); } catch {}
    this.tabs.delete(tabId);
    this.meta.delete(key);
    this.shared.emitTabClosed(this.browserId, tabId);
  }

  parkTab(tabId: string) {
    const key = this.tabKey(tabId);
    const meta = this.meta.get(key);
    if (!meta) return;
    meta.parked = true;
    this.cancelAutoSuspend(tabId);
    const view = this.tabs.get(tabId);
    if (this.activeTabId === tabId && this.shared.mainWindow && view && !view.webContents.isDestroyed()) {
      try { this.shared.mainWindow.contentView.removeChildView(view); } catch {}
      try { (view.webContents as any).setBackgroundThrottling?.(true); } catch {}
      try { view.webContents.setAudioMuted(true); } catch {}
      this.activeTabId = null;
    } else if (view && !view.webContents.isDestroyed()) {
      try { (view.webContents as any).setBackgroundThrottling?.(true); } catch {}
      try { view.webContents.setAudioMuted(true); } catch {}
    }
    this.emit(tabId);
  }

  unparkTab(tabId: string) {
    const key = this.tabKey(tabId);
    const meta = this.meta.get(key);
    if (!meta) return;
    meta.parked = false;
    const view = this.tabs.get(tabId);
    if (view && !view.webContents.isDestroyed()) {
      try { (view.webContents as any).setBackgroundThrottling?.(false); } catch {}
      try { view.webContents.setAudioMuted(false); } catch {}
    }
    this.lastActiveAt.set(key, Date.now());
    this.emit(tabId);
    for (const [tid] of this.tabs) if (tid !== tabId) this.scheduleAutoSuspend(tid);
  }

  getTabs() {
    const list: any[] = [];
    for (const [tabId] of this.tabs) {
      const m = this.meta.get(this.tabKey(tabId));
      if (m) list.push({ tabId, ...m });
    }
    return { tabs: list, activeTabId: this.activeTabId };
  }

  listAllTabsForExport() {
    const all: any[] = [];
    for (const [tabId, view] of this.tabs) {
      const m = this.meta.get(this.tabKey(tabId));
      all.push({ browserId: this.browserId, tabId, url: m?.url, title: m?.title, loading: !!m?.loading, parked: !!m?.parked, favicon: m?.favicon, active: this.activeTabId === tabId, destroyed: view.webContents.isDestroyed() });
    }
    return all;
  }

  updateBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.lastBounds = bounds;
    if (this.activeTabId) {
      const view = this.tabs.get(this.activeTabId);
      if (view && !view.webContents.isDestroyed() && this.shared.activeBrowserId === this.browserId) {
        try { view.setBounds(bounds as any); } catch {}
      }
    }
  }

  navigate(url: string) {
    const tid = this.activeTabId;
    if (!tid) return;
    const view = this.tabs.get(tid);
    if (!view || view.webContents.isDestroyed()) return;
    const canGoBack = () => { try{ const n:any=(view.webContents as any).navigationHistory; return n? n.canGoBack() : (view.webContents as any).canGoBack(); }catch{ return false; } };
    const canGoForward = () => { try{ const n:any=(view.webContents as any).navigationHistory; return n? n.canGoForward() : (view.webContents as any).canGoForward(); }catch{ return false; } };
    const goBack = () => { try{ const n:any=(view.webContents as any).navigationHistory; n? n.goBack() : view.webContents.goBack(); }catch{} };
    const goForward = () => { try{ const n:any=(view.webContents as any).navigationHistory; n? n.goForward() : view.webContents.goForward(); }catch{} };
    if (url === 'back') { if (canGoBack()) goBack(); }
    else if (url === 'forward') { if (canGoForward()) goForward(); }
    else if (url === 'reload') view.webContents.reload();
    else if (url === 'stop') view.webContents.stop();
    else view.webContents.loadURL(url).catch(() => {});
  }

  show() {
    this.shared.activeBrowserId = this.browserId;
    if (this.activeTabId) {
      const view = this.tabs.get(this.activeTabId);
      if (view && !view.webContents.isDestroyed() && this.shared.mainWindow) {
        try { this.shared.mainWindow.contentView.addChildView(view); } catch {}
        if (this.lastBounds) try { view.setBounds(this.lastBounds as any); } catch {}
        try { (view.webContents as any).setBackgroundThrottling?.(false); } catch {}
        try { view.webContents.setAudioMuted(false); } catch {}
        if (this.shared.extensionsManager) try { this.shared.extensionsManager.selectTab(view.webContents); } catch {}
      }
    } else if (this.tabs.size === 0) {
      const tid = `tab-${Date.now()}`;
      const view = this.ensureTabView(tid, 'https://duckduckgo.com');
      this.activeTabId = tid;
      if (this.shared.mainWindow) {
        try { this.shared.mainWindow.contentView.addChildView(view); } catch {}
        if (this.lastBounds) try { view.setBounds(this.lastBounds as any); } catch {}
      }
    } else {
      // No activeTabId but tabs exist — pick first
      const first = this.tabs.keys().next().value;
      if (first) this.switchTab(first);
    }
  }

  hide() {
    if (this.activeTabId) {
      const view = this.tabs.get(this.activeTabId);
      if (view && this.shared.mainWindow) {
        try { this.shared.mainWindow.contentView.removeChildView(view); } catch {}
        const meta = this.meta.get(this.tabKey(this.activeTabId));
        if (!meta?.parked) {
          try { this.shared.mainWindow.contentView.addChildView(view, 0); } catch {}
        }
      }
    }
  }

  destroy() {
    for (const [tid, view] of this.tabs) {
      if (this.activeTabId === tid && this.shared.mainWindow) try { this.shared.mainWindow.contentView.removeChildView(view); } catch {}
      if (!view.webContents.isDestroyed()) try { view.webContents.close(); } catch {}
      this.meta.delete(this.tabKey(tid));
    }
    this.tabs.clear();
    this.activeTabId = null;
  }
}
