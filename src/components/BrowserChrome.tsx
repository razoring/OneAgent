import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, X as XIcon, Plus, Lock, Globe, Search, Puzzle, Store, Trash2 } from 'lucide-react';
import TitleBar from './TitleBar';

interface BrowserChromeProps {
  agentId: string;
  onExit?: () => void;
}

interface Tab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  parked?: boolean;
  favicon?: string;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

function splitUrl(url: string): { origin: string; rest: string } {
  try {
    const u = new URL(url);
    const origin = u.origin !== 'null' ? `${u.protocol}//${u.host}` : '';
    const rest = url.slice(origin.length);
    return { origin, rest };
  } catch {
    return { origin: '', rest: url };
  }
}

const BrowserChrome: React.FC<BrowserChromeProps> = ({ agentId, onExit }) => {
  const [tabs, setTabs] = useState<Tab[]>([{ id: 'default', title: 'New Tab', url: 'https://duckduckgo.com', loading: false, parked: false }]);
  const [activeTabId, setActiveTabId] = useState('default');
  const [isVertical, setIsVertical] = useState(false);
  const [inputUrl, setInputUrl] = useState('');
  const [isInputFocused, setIsInputFocused] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [extensions, setExtensions] = useState<any[]>([]);
  const [extInput, setExtInput] = useState('');
  const [extLoading, setExtLoading] = useState(false);

  const activeTab = tabs.find(t => t.id === activeTabId);

  useEffect(() => {
    if (activeTab) setInputUrl(activeTab.url);
  }, [activeTab?.url]);

  // Subscribe to main-process tab updates (title/url/loading/parked/favicon/nav)
  useEffect(() => {
    const api: any = (window as any).electronAPI;
    if (!api?.onBrowserTabUpdated) return;
    const off = api.onBrowserTabUpdated((data: any) => {
      if (data.agentId !== agentId) return;
      setTabs(prev => prev.map(t => t.id === data.tabId ? {
        ...t,
        title: data.title ?? t.title,
        url: data.url ?? t.url,
        loading: !!data.loading,
        parked: !!data.parked,
        favicon: data.favicon ?? t.favicon,
        canGoBack: data.canGoBack ?? t.canGoBack,
        canGoForward: data.canGoForward ?? t.canGoForward,
      } : t));
    });
    const off2 = api.onBrowserTabClosed ? api.onBrowserTabClosed((data: any) => {
      if (data.agentId !== agentId) return;
      setTabs(prev => prev.filter(t => t.id !== data.tabId));
    }) : undefined;
    return () => { off?.(); off2?.(); };
  }, [agentId]);

  // Ensure every tab has backing view, and switch to active tab
  useEffect(() => {
    const api: any = (window as any).electronAPI;
    if (!api?.browserCreateTab) return;
    tabs.forEach(t => {
      if (!t.parked) api.browserCreateTab(agentId, t.id, t.url).catch(() => {});
    });
  }, []); // once

  useEffect(() => {
    const api: any = (window as any).electronAPI;
    if (!api?.browserCreateTab || !api?.browserSwitchTab) return;
    const cur = tabs.find(t => t.id === activeTabId);
    if (!cur) return;
    // Auto-unpark handled in main (switch will clear parked)
    api.browserCreateTab(agentId, cur.id, cur.url)
      .catch(() => {})
      .finally(() => {
        api.browserSwitchTab(agentId, cur.id).catch(() => {});
        // push bounds after switch so view gets correct position
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (contentRef.current) {
              const rect = contentRef.current.getBoundingClientRect();
              api.browserUpdateBounds?.({
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              });
            }
          }, 40);
        });
      });
  }, [activeTabId, agentId]);

  useEffect(() => {
    const updateBounds = () => {
      if (contentRef.current) {
        const rect = contentRef.current.getBoundingClientRect();
        const api = (window as any).electronAPI;
        if (api?.browserUpdateBounds) {
          api.browserUpdateBounds({
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
        }
      }
    };
    updateBounds();
    window.addEventListener('resize', updateBounds);
    const observer = new ResizeObserver(updateBounds);
    if (contentRef.current) observer.observe(contentRef.current);
    // also listen for maximize/fullscreen which don't fire resize immediately
    const onViz = () => setTimeout(updateBounds, 100);
    window.addEventListener('focus', onViz);
    return () => {
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('focus', onViz);
      observer.disconnect();
    };
  }, [isVertical]);

  // Keyboard shortcuts: Ctrl+L focus omnibox, Ctrl+T new tab, Ctrl+W close, Ctrl+Tab switch
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        urlInputRef.current?.focus();
        urlInputRef.current?.select();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        addTab();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const cur = tabs.find(t => t.id === activeTabId);
        if (cur) closeTab(e as any, cur.id);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        e.preventDefault();
        const idx = tabs.findIndex(t => t.id === activeTabId);
        const next = e.shiftKey ? (idx - 1 + tabs.length) % tabs.length : (idx + 1) % tabs.length;
        setActiveTabId(tabs[next].id);
      }
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
        e.preventDefault();
        (window as any).electronAPI?.browserNavigate?.('reload');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs, activeTabId]);

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    let target = inputUrl.trim();
    if (!target) return;
    // Support view-source:, chrome://, about:, file: literally
    const isSpecial = /^(about:|chrome:|view-source:|file:|data:)/i.test(target);
    if (!isSpecial && !target.startsWith('http://') && !target.startsWith('https://')) {
      if (target.includes('.') && !target.includes(' ')) target = 'https://' + target;
      else target = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(target);
    }
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: target, title: t.title === 'New Tab' ? target : t.title } : t));
    const api = (window as any).electronAPI;
    if (api?.browserNavigate) api.browserNavigate(target);
    urlInputRef.current?.blur();
  };

  const toggleLayout = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsVertical(!isVertical);
  };

  const addTab = () => {
    const id = `tab-${Date.now()}`;
    const newTab: Tab = { id, title: 'New Tab', url: 'https://duckduckgo.com', loading: false, parked: false };
    setTabs(t => [...t, newTab]);
    (window as any).electronAPI?.browserCreateTab(agentId, id, newTab.url).catch(() => {});
    setActiveTabId(id);
    setTimeout(() => urlInputRef.current?.select(), 80);
  };
  const closeTab = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setTabs(prev => {
      if (prev.length === 1) return prev;
      const idx = prev.findIndex(t => t.id === id);
      const next = prev.filter(t => t.id !== id);
      if (activeTabId === id) setActiveTabId(next[Math.max(0, idx - 1)].id);
      return next;
    });
    (window as any).electronAPI?.browserCloseTab(agentId, id).catch(() => {});
  };

  const refreshExtensions = async () => {
    try {
      const api: any = (window as any).electronAPI;
      const r = await api.extensionsList();
      if (r?.success) setExtensions(r.extensions || []);
    } catch {}
  };
  useEffect(() => { refreshExtensions(); }, []);
  const handleInstallFromStore = async () => {
    const idOrUrl = extInput.trim();
    if (!idOrUrl) return;
    setExtLoading(true);
    try {
      const api: any = (window as any).electronAPI;
      const r = await api.extensionsInstallFromStore(idOrUrl);
      if (!r.success) alert('Install failed: ' + (r.error || 'unknown'));
      else { setExtInput(''); await refreshExtensions(); }
    } finally { setExtLoading(false); }
  };
  const handleLoadFile = async () => {
    try {
      const api: any = (window as any).electronAPI;
      const res = await api.dialogShowOpen({ properties: ['openFile', 'openDirectory'], filters: [{ name: 'Extension', extensions: ['crx', 'zip'] }] });
      if (res?.canceled || !res.filePaths?.[0]) return;
      const r = await api.extensionsLoadFile(res.filePaths[0]);
      if (!r.success) alert('Load failed: ' + r.error);
      else await refreshExtensions();
    } catch (e: any) { alert(String(e)); }
  };
  const handleRemoveExt = async (id: string) => {
    const api: any = (window as any).electronAPI;
    const r = await api.extensionsRemove(id);
    if (!r.success) alert('Remove failed: ' + r.error);
    else await refreshExtensions();
  };
  const handleOpenStore = async () => {
    const api: any = (window as any).electronAPI;
    await api.extensionsOpenStore().catch(() => {});
    // navigate standalone or agent tab to store
    const storeUrl = 'https://chromewebstore.google.com/';
    setTabs(prev => prev.map(t => t.id === activeTabId ? { ...t, url: storeUrl } : t));
    setInputUrl(storeUrl);
    api.browserNavigate?.(storeUrl);
    if (agentId === '__standalone__') api.standaloneNavigate?.(storeUrl);
  };

  const displayUrl = activeTab?.url || inputUrl;
  const { origin, rest } = splitUrl(displayUrl || '');
  const isSecure = displayUrl.startsWith('https://');
  const showSearchIcon = !isSecure && !displayUrl.startsWith('http');

  const renderTabs = () => (
    <div className={`flex flex-1 min-w-0 ${isVertical ? 'flex-col gap-1 w-48 p-2 border-r border-white/10 bg-black/40' : 'h-full items-center gap-1 px-2 overflow-hidden'} `} onContextMenu={toggleLayout}>
      <div className={`flex ${isVertical ? 'flex-col gap-1 w-full' : 'flex-1 items-end gap-1 min-w-0 h-full pt-1 overflow-x-auto scrollbar-none'}`}>
        {tabs.map(tab => (
          <div
            key={tab.id}
            title={tab.parked ? `Sleeping — ${tab.url}` : tab.url}
            className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-t-md border border-b-0 cursor-pointer text-xs shrink-0 no-drag-region
              ${isVertical ? 'rounded-b-md border-b w-full' : 'max-w-[200px] min-w-[120px] h-8'} 
              ${tab.parked ? 'opacity-50 bg-white/[0.04] border-white/5 italic' : activeTabId === tab.id ? 'bg-[#242424] border-white/10 text-white' : 'bg-transparent border-transparent text-textSecondary hover:bg-white/5'}
            `}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.loading && !tab.parked ? (
              <span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-white animate-spin shrink-0" />
            ) : tab.favicon ? (
              <img src={tab.favicon} alt="" className={`w-3.5 h-3.5 rounded-sm shrink-0 ${tab.parked ? 'grayscale opacity-60' : ''}`} onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = 'none')} />
            ) : (
              <Globe size={12} className={`shrink-0 ${tab.parked ? 'opacity-40' : 'opacity-60'}`} />
            )}
            <div className={`flex-1 truncate ${tab.parked ? 'text-textSecondary' : ''}`}>{tab.title}</div>
            <button onClick={(e) => closeTab(e, tab.id)} className="opacity-60 group-hover:opacity-100 p-0.5 hover:bg-white/10 rounded-sm no-drag-region shrink-0">
              <XIcon size={12} />
            </button>
          </div>
        ))}
        <button onClick={addTab} className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md ml-1 shrink-0 no-drag-region" title="New Tab (Ctrl+T)">
          <Plus size={14} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col w-full h-full bg-black text-gray-200">
      {!isVertical && (
        <TitleBar>
          {renderTabs()}
        </TitleBar>
      )}
      {isVertical && <TitleBar />}
      <div className="flex flex-1 overflow-hidden app-region-no-drag">
        {isVertical && renderTabs()}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-8 bg-[#1e1e1e] flex items-center px-3 gap-2 border-b border-white/10 z-10 text-xs text-textSecondary">
            <Puzzle size={12} />
            <span className="font-semibold">Extensions ({extensions.length})</span>
            <div className="flex items-center gap-2 ml-3 flex-1 min-w-0">
              <input value={extInput} onChange={e => setExtInput(e.target.value)} placeholder="Paste Chrome Web Store URL or 32-char ID" className="flex-1 bg-black/40 border border-white/10 rounded-md px-2 py-1 text-xs text-white placeholder:text-white/40 outline-none focus:border-accent" />
              <button onClick={handleInstallFromStore} disabled={extLoading || !extInput.trim()} className="px-2 py-1 bg-accent text-black rounded-md text-xs font-semibold disabled:opacity-40">{extLoading ? 'Installing…' : 'Install'}</button>
              <button onClick={handleLoadFile} className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded-md">Load .crx/.zip</button>
              <button onClick={handleOpenStore} className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded-md flex items-center gap-1"><Store size={12}/> Store</button>
              <button onClick={refreshExtensions} className="px-2 py-1 bg-white/5 hover:bg-white/10 rounded-md">Refresh</button>
            </div>
            <div className="flex items-center gap-1 overflow-x-auto max-w-[40%]">
              {extensions.map((e: any) => (
                <span key={e.id} className="inline-flex items-center gap-1 bg-black/40 border border-white/10 rounded-full px-2 py-0.5 text-[11px] shrink-0" title={`${e.name} v${e.version} — ${e.id}`}>
                  <span className="truncate max-w-[120px]">{e.name}</span>
                  <button onClick={() => handleRemoveExt(e.id)} className="p-0.5 hover:bg-white/10 rounded-full"><Trash2 size={10}/></button>
                </span>
              ))}
            </div>
          </div>
          <div className="h-12 bg-surface flex items-center px-3 gap-2 border-b border-white/10 z-10 shadow-sm pointer-events-auto">
            <div className="flex items-center gap-1">
              <button onClick={() => (window as any).electronAPI?.browserNavigate?.('back')} disabled={!activeTab?.canGoBack} className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md disabled:opacity-30 disabled:cursor-not-allowed"><ChevronLeft size={18}/></button>
              <button onClick={() => (window as any).electronAPI?.browserNavigate?.('forward')} disabled={!activeTab?.canGoForward} className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md disabled:opacity-30 disabled:cursor-not-allowed"><ChevronRight size={18}/></button>
              <button onClick={() => activeTab?.loading ? (window as any).electronAPI?.browserNavigate?.('stop') : (window as any).electronAPI?.browserNavigate?.('reload')} className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md"><RotateCw size={16} className={activeTab?.loading ? 'animate-spin' : ''}/></button>
            </div>

            <form onSubmit={handleNavigate} className="flex-1 ml-2 flex items-center bg-black/40 border border-white/5 rounded-full px-3 py-0 gap-2 focus-within:ring-1 focus-within:ring-accent focus-within:border-accent relative h-8">
              <span className="shrink-0">
                {showSearchIcon ? <Search size={14} className="text-textSecondary" /> : isSecure ? <Lock size={13} className="text-emerald-400" /> : <Globe size={13} className="text-textSecondary" />}
              </span>
              {/* Segmented overlay when not focused */}
              {!isInputFocused && (
                <div
                  onClick={() => { setIsInputFocused(true); setTimeout(() => { urlInputRef.current?.focus(); urlInputRef.current?.select(); }, 0); }}
                  className="absolute inset-0 left-8 right-2 flex items-center text-sm font-medium truncate cursor-text select-none"
                  title={displayUrl}
                >
                  <span className="text-white truncate">{origin}</span>
                  <span className="text-white/50 truncate">{rest}</span>
                </div>
              )}
              <input
                ref={urlInputRef}
                type="text"
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                onFocus={() => { setIsInputFocused(true); setTimeout(() => urlInputRef.current?.select(), 0); }}
                onBlur={() => setIsInputFocused(false)}
                onKeyDown={(e) => { if (e.key === 'Escape') { setInputUrl(activeTab?.url || ''); (e.target as HTMLInputElement).blur(); } }}
                className={`flex-1 bg-transparent border-none outline-none text-sm font-medium h-full ${isInputFocused ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                placeholder="Search or enter URL"
                spellCheck={false}
              />
            </form>

            {onExit && (
              <button onClick={onExit} className="px-3 py-1.5 text-xs font-semibold bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-md transition-colors ml-2 border border-red-500/30">
                Return to Chat
              </button>
            )}
          </div>
          <div className="flex-1 bg-white relative pointer-events-none" ref={contentRef}>
            {/* The active tab's WebContentsView is positioned here by main.ts */}
          </div>
        </div>
      </div>
    </div>
  );
};

export default BrowserChrome;
