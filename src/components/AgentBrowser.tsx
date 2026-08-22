import React, { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Shield } from 'lucide-react';
import { agentBrowserStore } from '../utils/agentBrowserStore';

// Live embedded browser driven by the agent's browser_* tools.
// Registers itself as window.activeWebview so browserTools.ts can drive it.
// Receives `incarnation` as a prop (used as React key by parent) to force
// a full remount when the browser is killed.
const AgentBrowser: React.FC<{ incarnation?: number }> = ({ incarnation }) => {
  // Frozen at mount: navigation is driven imperatively (loadURL) by
  // browserTools — rewriting the src attribute mid-flight causes ERR_ABORTED.
  const [initialSrc] = useState(() => agentBrowserStore.getUrl());
  const [displayUrl, setDisplayUrl] = useState(initialSrc);
  const webviewRef = useRef<any>(null);

  useEffect(() => agentBrowserStore.subscribe(url => setDisplayUrl(url)), []);

  // Reset scale on every mount (including remounts after kill)
  useEffect(() => {
    (window as any).__oneagentBrowserScale = 0.5;
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    (window as any).activeWebview = webview;

    const handleDomReady = () => {
      const electronAPI = (window as any).electronAPI;
      if (electronAPI?.browserEmulateDevice) {
        electronAPI.browserEmulateDevice(webview.getWebContentsId(), {
          screenPosition: 'desktop',
          screenSize: { width: 1280, height: 680 },
          viewPosition: { x: 0, y: 0 },
          viewSize: { width: 1280, height: 680 },
          scale: 0.5
        });
      }
    };

    const handleDidFinishLoad = () => {
      agentBrowserStore.navigate(webview.getURL());
    };

    // -3 = ERR_ABORTED: a navigation was superseded (expected when the agent
    // redirects mid-load). Subframe loads report isMainFrame=false. Ignore both.
    const handleDidFailLoad = (e: any) => {
      if (e?.errorCode === -3 || e?.isMainFrame === false) return;
      console.warn('[AgentBrowser] load failed:', e?.errorDescription || e);
    };

    webview.addEventListener('dom-ready', handleDomReady);
    webview.addEventListener('did-finish-load', handleDidFinishLoad);
    webview.addEventListener('did-fail-load', handleDidFailLoad);
    return () => {
      if ((window as any).activeWebview === webview) {
        (window as any).activeWebview = null;
      }
      webview.removeEventListener('dom-ready', handleDomReady);
      webview.removeEventListener('did-finish-load', handleDidFinishLoad);
      webview.removeEventListener('did-fail-load', handleDidFailLoad);
    };
  }, []);

  const goBack = () => webviewRef.current?.goBack();
  const goForward = () => webviewRef.current?.goForward();
  const reload = () => webviewRef.current?.reload();

  return (
    <div className="flex flex-col h-[340px] bg-white overflow-hidden">
      {/* Mini toolbar */}
      <div className="h-9 shrink-0 bg-surface flex items-center px-2 gap-1.5 border-b border-white/10">
        <button onClick={goBack} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Back">
          <ChevronLeft size={15} />
        </button>
        <button onClick={goForward} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Forward">
          <ChevronRight size={15} />
        </button>
        <button onClick={reload} className="p-1 text-textSecondary hover:text-white hover:bg-white/10 rounded transition-colors" title="Reload">
          <RotateCw size={13} />
        </button>
        <div className="flex-1 flex items-center gap-1.5 bg-black/40 border border-white/5 rounded px-2 py-1 min-w-0">
          <Shield size={11} className="text-accentBright shrink-0" />
          <span className="text-[11px] font-mono text-gray-300 truncate select-text">{displayUrl}</span>
        </div>
      </div>

      {/* Live page */}
      <div className="relative flex-1 w-full overflow-hidden bg-white">
        {/* @ts-ignore - webview is a custom element in Electron */}
        <webview
          ref={webviewRef}
          src={initialSrc}
          className="w-full h-full"
          partition="persist:oneagent_browser"
          webpreferences="contextIsolation=yes,javascript=yes"
          allowpopups
        />
      </div>
    </div>
  );
};

export default AgentBrowser;
