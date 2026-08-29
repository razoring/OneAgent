import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Home, Shield, X, Plus, Bot } from 'lucide-react';
import { agentBrowserStore, BrowserTab } from '../utils/agentBrowserStore';

// DEPRECATED: Use LiveEmbeddedContainer (embedded headless + live-in-container).
// Kept for reference — not mounted in App.tsx. LiveEmbeddedContainer is the
// single embedded browser (headless offscreen HIDDEN_BOUNDS, moved to slot bounds on expand).

const HOME_URL = 'https://html.duckduckgo.com/';
const CHROME_HEIGHT = 72; // tab strip (36) + toolbar (36)

const normalizeUrl = (raw: string): string => {
  const target = raw.trim();
  if (!target) return HOME_URL;
  if (target.startsWith('http://') || target.startsWith('https://')) return target;
  if (target.includes('.') && !target.includes(' ')) return 'https://' + target;
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(target);
};

let mountInitialized = false;

const AgentBrowser: React.FC = () => {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => agentBrowserStore.getTabs());
  const [activeId, setActiveId] = useState<string | null>(() => agentBrowserStore.getActiveId());
  const [inputUrl, setInputUrl] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  // Bootstrap: create the main-process window for the home tab exactly once per
  // app session (StrictMode double-mounts must not spawn duplicate windows).
  useEffect(() => {
    if (mountInitialized) return;
    mountInitialized = true;
    void (async () => {
      try {
        const id: string | undefined = await (window as any).electronAPI.tabCreate(HOME_URL);
        if (!id) return;
        if (agentBrowserStore.getTabs().length === 0) {
          agentBrowserStore.addTab({ id, title: 'New Tab', url: HOME_URL, agentId: null });
        } else {
          agentBrowserStore.rekeyTab(agentBrowserStore.getTabs()[0].id, id);
        }
        setActiveId(agentBrowserStore.getActiveId());
      } catch (e) {
        console.error('[AgentBrowser] bootstrap failed', e);
      }
    })();
  }, []);

  useEffect(() => {
    const u1 = agentBrowserStore.subscribeTabs(setTabs);
    const u2 = agentBrowserStore.subscribeActive(id => {
      setActiveId(id);
      const tab = id ? agentBrowserStore.getTab(id) : undefined;
      if (tab) setInputUrl(tab.url);
    });
    const offNewTab = (window as any).electronAPI?.onBrowserNewTab?.((url: string) => {
      void (async () => {
        const id: string | undefined = await (window as any).electronAPI.tabCreate(url);
        if (id) agentBrowserStore.addTab({ id, title: 'New Tab', url, agentId: null, loading: true });
      })();
    });
    return () => { u1(); u2(); offNewTab?.(); };
  }, []);

  // Full reset (user trash button): destroy every main-process window and
  // bootstrap one fresh home tab.
  useEffect(() => {
    const recreate = () => {
      void (async () => {
        for (const t of agentBrowserStore.getTabs()) {
          try { await (window as any).electronAPI.tabClose(t.id); } catch {}
        }
        agentBrowserStore.reset();
        const id: string | undefined = await (window as any).electronAPI.tabCreate(HOME_URL);
        if (id) agentBrowserStore.addTab({ id, title: 'New Tab', url: HOME_URL, agentId: null });
      })();
    };
    window.addEventListener('oneagent-browser-recreate', recreate);
    return () => window.removeEventListener('oneagent-browser-recreate', recreate);
  }, []);

  const activeTab = tabs.find(t => t.id === activeId);

  // Geometry sync: single RAF pushes the ACTIVE tab's content area to the
  // main process as viewport-relative bounds (WebContentsView-relative, 1:1).
  useEffect(() => {
    let raf = 0;
    let last = '';
    const sync = () => {
      raf = requestAnimationFrame(sync);
      const root = rootRef.current;
      if (!root || !activeId) return;
      const r = root.getBoundingClientRect();
      // Layer parked off-screen when slot is collapsed/hidden — detach instead of positioning off-screen.
      if (r.left < -5000 || r.width <= 0 || r.height <= CHROME_HEIGHT) return;
      const bounds = {
        x: Math.round(r.left),
        y: Math.round(r.top + CHROME_HEIGHT),
        width: Math.round(r.width),
        height: Math.max(0, Math.round(r.height - CHROME_HEIGHT)),
      };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === last) return;
      last = key;
      void (window as any).electronAPI.tabBounds(activeId, bounds);
    };
    raf = requestAnimationFrame(sync);
    return () => cancelAnimationFrame(raf);
  }, [activeId]);

  // Attach active tab on switch, detach previous. Single source for visibility.
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeId;
    if (prev && prev !== activeId) void (window as any).electronAPI.tabHide(prev);
    if (activeId) {
      const root = rootRef.current;
      const r = root?.getBoundingClientRect();
      const bounds = r && r.width > 0 ? { x: Math.round(r.left), y: Math.round(r.top + CHROME_HEIGHT), width: Math.round(r.width), height: Math.max(0, Math.round(r.height - CHROME_HEIGHT)) } : undefined;
      void (window as any).electronAPI.tabActivate(activeId, bounds);
    }
  }, [activeId]);

  const navigateActive = async (raw: string) => {
    if (!activeId) return;
    const url = normalizeUrl(raw);
    agentBrowserStore.patchTab(activeId, { url, loading: true });
    setInputUrl(url);
    try { await (window as any).electronAPI.tabCall(activeId, 'loadURL', url); } catch {}
  };

  const withActiveTab = (method: string) => {
    if (!activeId) return;
    void (window as any).electronAPI.tabCall(activeId, method).catch?.(() => {});
  };

  const closeTab = (id: string) => {
    void (window as any).electronAPI.tabClose(id);
    agentBrowserStore.closeTab(id);
  };

  const openNewTab = () => {
    void (async () => {
      const id: string | undefined = await (window as any).electronAPI.tabCreate({ url: HOME_URL });
      if (id) agentBrowserStore.addTab({ id, title: 'New Tab', url: HOME_URL, agentId: null });
    })();
  };

  return (
    <div ref={rootRef} id="oneagent-browser-root" className="flex flex-col w-full h-full bg-surface overflow-hidden">
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
        <button onClick={() => withActiveTab('goBack')} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Back">
          <ChevronLeft size={14} />
        </button>
        <button onClick={() => withActiveTab('goForward')} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Forward">
          <ChevronRight size={14} />
        </button>
        <button onClick={() => withActiveTab('reload')} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Reload">
          <RotateCw size={12} />
        </button>
        <form onSubmit={(e) => { e.preventDefault(); void navigateActive(inputUrl); }} className="flex-1 flex items-center gap-1.5 bg-black/40 border border-white/5 focus-within:border-accent/50 rounded-md px-2 py-1 min-w-0 mx-1">
          <Shield size={10} className="text-accentBright shrink-0" />
          <input
            type="text"
            value={inputUrl || activeTab?.url || ''}
            onChange={e => setInputUrl(e.target.value)}
            onFocus={() => { if (activeTab) setInputUrl(activeTab.url); }}
            placeholder="Search or enter URL"
            className="flex-1 bg-transparent outline-none text-[11px] font-mono text-gray-300 min-w-0 select-text"
          />
        </form>
        <button onClick={() => void navigateActive(HOME_URL)} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Home">
          <Home size={13} />
        </button>
      </div>

      {/* Page surface is composited by the main process behind this spacer —
          it occupies everything below the chrome. */}
      <div className="flex-1 w-full bg-white" />
    </div>
  );
};

export default AgentBrowser;
