import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Home, Shield, X, Plus, Bot } from 'lucide-react';
import { agentBrowserStore, syncLegacyGlobals, BrowserTab } from '../utils/agentBrowserStore';

// Live embedded browser driven by the agent's browser_* tools — now a
// multi-tab Chrome-style shell. Every actor (user + each sub-agent) gets its
// own <webview> tab so agents browse concurrently without stealing pages.
//
// Constraints honored here:
//  - The whole layer mounts ONCE (App.tsx) and is teleported over tool slots;
//    individual webviews are never reparented, only shown/hidden in place.
//  - Webview elements register into window.__oneagentTabs; browserTools
//    resolves the acting agent's tab through it.

const HOME_URL = 'https://html.duckduckgo.com/';

// One <webview> per tab — mounted for the tab's whole lifetime.
const TabWebview: React.FC<{ tab: BrowserTab; visible: boolean }> = ({ tab, visible }) => {
  const ref = useRef<any>(null);
  // Frozen at mount: ALL later navigation is imperative (loadURL). Letting
  // React write the src attribute after mount triggers a second navigation
  // that supersedes the in-flight one (ERR_ABORTED) — the page visually sticks.
  const [frozenSrc] = useState(() => tab.url);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const registry: Map<string, { wv: any; ready: boolean }> = (window as any).__oneagentTabs ||= new Map();
    // Always (re)set — StrictMode replays this effect (setup→cleanup→setup)
    // on the SAME element, and skipping re-registration left the tab orphaned
    // from the registry ("No active webview available" forever).
    registry.set(tab.id, { wv, ready: false });

    const markLoading = () => agentBrowserStore.patchTab(tab.id, { loading: true });
    const markStopped = () => agentBrowserStore.patchTab(tab.id, { loading: false });
    const handleDomReady = () => {
      const entry = registry.get(tab.id);
      if (entry && entry.wv === wv) entry.ready = true;
      markStopped();
      try {
        (window as any).electronAPI.browserEmulateDevice(wv.getWebContentsId(), {
          screenPosition: 'desktop',
          screenSize: { width: 1280, height: 800 },
          viewPosition: { x: 0, y: 0 },
          viewSize: { width: 1280, height: 800 },
          scale: 1
        });
      } catch {}
    };
    const handleNavigate = () => {
      try { agentBrowserStore.patchTab(tab.id, { url: wv.getURL() }); } catch {}
    };
    const handleTitle = () => {
      try { agentBrowserStore.patchTab(tab.id, { title: wv.getTitle() || tab.title }); } catch {}
    };
    const handleFail = (e: any) => {
      if (e?.errorCode === -3 || e?.isMainFrame === false) return;
      markStopped();
    };

    wv.addEventListener('dom-ready', handleDomReady);
    wv.addEventListener('did-start-loading', markLoading);
    wv.addEventListener('did-stop-loading', markStopped);
    wv.addEventListener('did-navigate', handleNavigate);
    wv.addEventListener('did-navigate-in-page', handleNavigate);
    wv.addEventListener('page-title-updated', handleTitle);
    wv.addEventListener('did-fail-load', handleFail);

    return () => {
      // Only remove OUR entry — a StrictMode replay may have replaced it with
      // a newer registration for the same tab id.
      const entry = registry.get(tab.id);
      if (entry && entry.wv === wv) registry.delete(tab.id);
      try { wv.stop(); } catch {}
      wv.removeEventListener('dom-ready', handleDomReady);
      wv.removeEventListener('did-start-loading', markLoading);
      wv.removeEventListener('did-stop-loading', markStopped);
      wv.removeEventListener('did-navigate', handleNavigate);
      wv.removeEventListener('did-navigate-in-page', handleNavigate);
      wv.removeEventListener('page-title-updated', handleTitle);
      wv.removeEventListener('did-fail-load', handleFail);
    };
  }, [tab.id]);

  // Frozen src: navigation is imperative (loadURL) — rewriting src mid-flight
  // causes ERR_ABORTED.
  return (
    <div
      className="w-full h-full bg-white"
      style={visible ? undefined : { position: 'absolute', left: -20000, top: 0 }}
    >
      {/* @ts-ignore - webview is a custom element in Electron */}
      <webview
        ref={ref}
        src={frozenSrc}
        className="w-full h-full"
        partition="persist:oneagent_browser"
        webpreferences="contextIsolation=yes,javascript=yes"
        allowpopups={"true" as any}
      />
    </div>
  );
};

const normalizeUrl = (raw: string): string => {
  const target = raw.trim();
  if (!target) return HOME_URL;
  if (target.startsWith('http://') || target.startsWith('https://')) return target;
  if (target.includes('.') && !target.includes(' ')) return 'https://' + target;
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(target);
};

const AgentBrowser: React.FC = () => {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => agentBrowserStore.getTabs());
  const [activeId, setActiveId] = useState<string | null>(() => agentBrowserStore.getActiveId());
  const [inputUrl, setInputUrl] = useState('');
  const [webviewEpoch, setWebviewEpoch] = useState(0);

  // Ensure a user tab always exists.
  useEffect(() => {
    agentBrowserStore.ensureHomeTab();
    setActiveId(agentBrowserStore.getActiveId());
  }, []);

  useEffect(() => {
    const u1 = agentBrowserStore.subscribeTabs(setTabs);
    const u2 = agentBrowserStore.subscribeActive(id => {
      setActiveId(id);
      const tab = id ? agentBrowserStore.getTab(id) : undefined;
      if (tab) setInputUrl(tab.url);
    });
    // Link targets (target=_blank, window.open) open as real new tabs.
    const offNewTab = (window as any).electronAPI?.onBrowserNewTab?.((url: string) => {
      agentBrowserStore.openUrlInNewTab(url);
    });
    return () => { u1(); u2(); offNewTab?.(); };
  }, []);

  // Full session recreate (user trash / remount): drop every webview element
  // and rebuild a fresh home tab. Bumping the epoch remounts all TabWebviews.
  useEffect(() => {
    const recreate = () => {
      const registry: Map<string, { wv: any }> = (window as any).__oneagentTabs ||= new Map();
      for (const [, entry] of registry) { try { entry.wv.stop(); } catch {} }
      registry.clear();
      tabs.forEach(t => agentBrowserStore.closeTab(t.id));
      agentBrowserStore.ensureHomeTab();
      setWebviewEpoch(e => e + 1);
    };
    window.addEventListener('oneagent-browser-recreate', recreate);
    return () => window.removeEventListener('oneagent-browser-recreate', recreate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  const activeTab = tabs.find(t => t.id === activeId);
  const activeRegistry = (): Map<string, { wv: any; ready: boolean }> => (window as any).__oneagentTabs ||= new Map();

  // Keep the legacy global pointer on the VISIBLE webview for stray consumers.
  useEffect(() => {
    const registry: Map<string, { wv: any; ready: boolean }> = (window as any).__oneagentTabs ||= new Map();
    const entry = activeId ? registry.get(activeId) : undefined;
    syncLegacyGlobals(entry?.wv ?? null, !!entry?.ready);
  }, [activeId, tabs]);

  const navigateActive = async (raw: string) => {
    if (!activeId) return;
    const url = normalizeUrl(raw);
    const registry = activeRegistry();
    const entry = activeId ? registry.get(activeId) : undefined;
    agentBrowserStore.patchTab(activeId, { url, loading: true });
    setInputUrl(url);
    if (!entry?.wv) return;
    // Freshly created tabs have no attached guest yet — wait for dom-ready
    // instead of throwing "not attached" and silently staying on the old page.
    const start = Date.now();
    while (!entry.ready && entry.wv.isConnected && Date.now() - start < 10000) {
      await new Promise(r => setTimeout(r, 80));
    }
    try { Promise.resolve(entry.wv.loadURL(url)).catch(() => {}); } catch {}
  };

  const withActiveWebview = (fn: (wv: any) => void) => {
    const entry = activeId ? activeRegistry().get(activeId) : undefined;
    if (entry?.wv) { try { fn(entry.wv); } catch {} }
  };

  const closeTab = (id: string) => {
    const registry = activeRegistry();
    const entry = registry.get(id);
    if (entry) { try { entry.wv.stop(); } catch {} registry.delete(id); }
    agentBrowserStore.closeTab(id);
  };

  const openNewTab = () => {
    const tab = agentBrowserStore.createUserTab();
    agentBrowserStore.activateTab(tab.id);
  };

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div id="oneagent-browser-root" className="flex flex-col w-full h-full bg-surface overflow-hidden">
      {/* Tab strip — chrome-like */}
      <div className="h-9 shrink-0 bg-black/40 flex items-end px-1.5 pt-1 gap-0.5 overflow-x-auto no-scrollbar">
        {tabs.map(tab => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              onClick={() => agentBrowserStore.activateTab(tab.id)}
              className={`group/tab h-8 min-w-[110px] max-w-[190px] flex items-center gap-1.5 px-2.5 rounded-t-lg transition-colors ${
                isActive ? 'bg-surface text-white' : 'bg-white/[0.04] text-textSecondary hover:bg-white/[0.08]'
              }`}
              title={tab.label ? `${tab.label} — ${tab.title}` : tab.title}
            >
              {tab.loading ? (
                <RotateCw size={11} className="animate-spin shrink-0 text-accentBright" />
              ) : (
                <Shield size={11} className={`shrink-0 ${tab.agentId ? 'text-accentBright' : 'text-textSecondary'}`} />
              )}
              {tab.agentId && <Bot size={11} className={`shrink-0 ${tab.busy ? 'text-accentBright animate-pulse' : 'text-textSecondary/70'}`} />}
              <span className="truncate text-[11px] font-medium flex-1 text-left">
                {tab.agentId && tab.label ? `${tab.label} · ${tab.title}` : tab.title}
              </span>
              {tab.busy && <span className="w-1.5 h-1.5 rounded-full bg-accentBright animate-pulse shrink-0" title="Agent is working here" />}
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                className="p-0.5 rounded hover:bg-white/15 opacity-0 group-hover/tab:opacity-100 transition-opacity shrink-0"
                title="Close tab"
              >
                <X size={10} />
              </span>
            </button>
          );
        })}
        <button
          onClick={openNewTab}
          className="h-7 w-7 mb-0.5 shrink-0 flex items-center justify-center rounded-md text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
          title="New tab"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* Toolbar */}
      <div className="h-9 shrink-0 bg-surface flex items-center px-2 gap-1 border-b border-white/10">
        <button onClick={() => withActiveWebview(wv => wv.goBack())} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Back">
          <ChevronLeft size={14} />
        </button>
        <button onClick={() => withActiveWebview(wv => wv.goForward())} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Forward">
          <ChevronRight size={14} />
        </button>
        <button onClick={() => withActiveWebview(wv => wv.reload())} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Reload">
          <RotateCw size={12} />
        </button>
        <form onSubmit={(e) => { e.preventDefault(); navigateActive(inputUrl); }} className="flex-1 flex items-center gap-1.5 bg-black/40 border border-white/5 focus-within:border-accent/50 rounded-md px-2 py-1 min-w-0 mx-1">
          <Shield size={10} className="text-accentBright shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={inputUrl || activeTab?.url || ''}
            onChange={e => setInputUrl(e.target.value)}
            onFocus={() => { if (activeTab) setInputUrl(activeTab.url); }}
            placeholder="Search or enter URL"
            className="flex-1 bg-transparent outline-none text-[11px] font-mono text-gray-300 min-w-0 select-text"
          />
        </form>
        <button onClick={() => navigateActive(HOME_URL)} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Home">
          <Home size={13} />
        </button>
      </div>

      {/* Stacked live pages — inactive tabs stay mounted (offscreen), never unmounted */}
      <div className="relative flex-1 w-full overflow-hidden bg-white">
        {tabs.map(tab => (
          <TabWebview key={`${tab.id}-${webviewEpoch}`} tab={tab} visible={tab.id === activeId} />
        ))}
      </div>
    </div>
  );
};

export default AgentBrowser;
