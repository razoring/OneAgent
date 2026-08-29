import React, { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Home, Shield, X, Plus, Bot } from 'lucide-react';
import { agentBrowserStore, BrowserTab } from '../utils/agentBrowserStore';

/**
 * LiveEmbeddedContainer — embedded browser that remains in its tool-call container.
 * Native WebContentsView is positioned over the page placeholder via
 * tabShowInContainer/tabHideInContainer. When container is collapsed, the view
 * is parked far offscreen (OFFSCREEN_BOUNDS x=6000) but stays ATTACHED to the
 * visible mainWindow with valid 1280x800 size so Chromium keeps painting and
 * concurrent headless screenshots (browser_observe) work without needing the
 * container to be opened. No hidden BrowserWindow — real Electron browsers keep
 * background tabs attached offscreen in the visible window.
 */
const HOME_URL = 'https://html.duckduckgo.com/';

const normalizeUrl = (raw: string): string => {
  const t = raw.trim();
  if (!t) return HOME_URL;
  if (t.startsWith('http://') || t.startsWith('https://')) return t;
  if (t.includes('.') && !t.includes(' ')) return 'https://' + t;
  return 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(t);
};

interface Props {
  isVisible: boolean;
}

let mountInitialized = false;

const LiveEmbeddedContainer: React.FC<Props> = ({ isVisible }) => {
  const [tabs, setTabs] = useState<BrowserTab[]>(() => agentBrowserStore.getTabs());
  const [activeId, setActiveId] = useState<string | null>(() => agentBrowserStore.getActiveId());
  const [inputUrl, setInputUrl] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // Bootstrap home tab once per app session
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
        console.error('[LiveEmbeddedContainer] bootstrap failed', e);
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

  // Full reset
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

  // Show/hide in container: when isVisible, position native view over page placeholder.
  // When hidden, park offscreen but keep attached for headless capture.
  useEffect(() => {
    if (!isVisible || !activeId) {
      // Park active tab offscreen when container collapsed or no active
      if (activeId) void (window as any).electronAPI.tabHideInContainer(activeId).catch(()=>{});
      return;
    }
    let raf = 0;
    let last = '';
    let ro: ResizeObserver | null = null;

    const sync = () => {
      raf = requestAnimationFrame(sync);
      const page = pageRef.current;
      if (!page || !activeId) return;
      const r = page.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return;
      // Page placeholder is the viewport for the native view (no chrome offset here)
      const bounds = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (key === last) return;
      last = key;
      void (window as any).electronAPI.tabShowInContainer(activeId, bounds);
    };
    raf = requestAnimationFrame(sync);

    // Also observe resize for container layout changes
    if (pageRef.current && (window as any).ResizeObserver) {
      ro = new ResizeObserver(() => {
        // force re-sync on resize
        last = '';
      });
      ro.observe(pageRef.current);
      // Observe root for chrome height changes
      if (rootRef.current) ro.observe(rootRef.current);
    }

    // Initial show
    const page = pageRef.current;
    if (page) {
      const r = page.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        void (window as any).electronAPI.tabShowInContainer(activeId, { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
      }
    }

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      // Park on unmount / hide
      if (activeId) void (window as any).electronAPI.tabHideInContainer(activeId).catch(()=>{});
    };
  }, [isVisible, activeId]);

  // Handle tab switch: hide previous, show new (if visible)
  const prevActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevActiveRef.current;
    prevActiveRef.current = activeId;
    if (prev && prev !== activeId) {
      void (window as any).electronAPI.tabHideInContainer(prev).catch(()=>{});
    }
    if (activeId && isVisible) {
      const page = pageRef.current;
      if (page) {
        const r = page.getBoundingClientRect();
        if (r.width > 0) {
          void (window as any).electronAPI.tabShowInContainer(activeId, { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
        }
      } else {
        // Fallback: ensure tab is at least parked visible check will reposition on next RAF
        void (window as any).electronAPI.tabShowInContainer(activeId, { x: 0, y: 0, width: 1280, height: 720 }).catch(()=>{});
      }
    }
  }, [activeId, isVisible]);

  const navigateActive = async (raw: string) => {
    if (!activeId) return;
    const url = normalizeUrl(raw);
    agentBrowserStore.patchTab(activeId, { url, loading: true });
    setInputUrl(url);
    try { await (window as any).electronAPI.tabCall(activeId, 'loadURL', url); } catch {}
  };
  const withActiveTab = (method: string) => {
    if (!activeId) return;
    void (window as any).electronAPI.tabCall(activeId, method).catch(()=>{});
  };
  const closeTab = (id: string) => {
    void (window as any).electronAPI.tabClose(id);
    agentBrowserStore.closeTab(id);
  };
  const openNewTab = () => {
    void (async () => {
      const id: string | undefined = await (window as any).electronAPI.tabCreate({ url: HOME_URL } as any);
      if (id) agentBrowserStore.addTab({ id, title: 'New Tab', url: HOME_URL, agentId: null });
    })();
  };

  return (
    <div ref={rootRef} className="flex flex-col w-full h-full bg-surface overflow-hidden">
      {/* Tab strip */}
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
              {tab.loading ? <RotateCw size={11} className="animate-spin shrink-0 text-accentBright" /> : <Shield size={11} className={`shrink-0 ${tab.agentId ? 'text-accentBright' : 'text-textSecondary'}`} />}
              {tab.agentId && <Bot size={11} className={`shrink-0 ${tab.busy ? 'text-accentBright animate-pulse' : 'text-textSecondary/70'}`} />}
              <span className="truncate text-[11px] font-medium flex-1 text-left">{tab.agentId && tab.label ? `${tab.label} · ${tab.title}` : tab.title}</span>
              {tab.busy && <span className="w-1.5 h-1.5 rounded-full bg-accentBright animate-pulse shrink-0" />}
              <span role="button" onClick={e=>{e.stopPropagation(); closeTab(tab.id);}} className="p-0.5 rounded hover:bg-white/15 opacity-0 group-hover/tab:opacity-100 transition-opacity shrink-0" title="Close tab"><X size={10} /></span>
            </button>
          );
        })}
        <button onClick={openNewTab} className="h-7 w-7 mb-0.5 shrink-0 flex items-center justify-center rounded-md text-textSecondary hover:text-white hover:bg-white/10 transition-colors" title="New tab"><Plus size={13} /></button>
      </div>
      {/* Toolbar */}
      <div className="h-9 shrink-0 bg-surface flex items-center px-2 gap-1 border-b border-white/10">
        <button onClick={()=>withActiveTab('goBack')} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Back"><ChevronLeft size={14} /></button>
        <button onClick={()=>withActiveTab('goForward')} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Forward"><ChevronRight size={14} /></button>
        <button onClick={()=>withActiveTab('reload')} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Reload"><RotateCw size={12} /></button>
        <form onSubmit={e=>{e.preventDefault(); void navigateActive(inputUrl);}} className="flex-1 flex items-center gap-1.5 bg-black/40 border border-white/5 focus-within:border-accent/50 rounded-md px-2 py-1 min-w-0 mx-1">
          <Shield size={10} className="text-accentBright shrink-0" />
          <input type="text" value={inputUrl || activeTab?.url || ''} onChange={e=>setInputUrl(e.target.value)} onFocus={()=>{ if(activeTab) setInputUrl(activeTab.url); }} placeholder="Search or enter URL" className="flex-1 bg-transparent outline-none text-[11px] font-mono text-gray-300 min-w-0 select-text" />
        </form>
        <button onClick={()=>void navigateActive(HOME_URL)} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Home"><Home size={13} /></button>
      </div>
      {/* Page surface — native WebContentsView is positioned over this placeholder */}
      <div ref={pageRef} className="flex-1 w-full bg-white relative overflow-hidden min-h-[320px]">
        {/* Fallback hint when headless (no view yet) */}
        {!isVisible && <div className="absolute inset-0 flex items-center justify-center text-xs text-textSecondary/50">Browser parked headless — expand to interact</div>}
      </div>
    </div>
  );
};

export default LiveEmbeddedContainer;
