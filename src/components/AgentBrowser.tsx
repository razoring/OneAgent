import React, { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Shield } from 'lucide-react';
import { agentBrowserStore } from '../utils/agentBrowserStore';

// Live embedded browser driven by the agent's browser_* tools.
// Registers itself as window.activeWebview so browserTools.ts can drive it.
const AgentBrowser: React.FC = () => {
  // Frozen at mount: navigation is driven imperatively (loadURL) by
  // browserTools — rewriting the src attribute mid-flight causes ERR_ABORTED.
  const [initialSrc] = useState(() => agentBrowserStore.getUrl());
  const [displayUrl, setDisplayUrl] = useState(initialSrc);
  const webviewRef = useRef<any>(null);

  useEffect(() => agentBrowserStore.subscribe(url => setDisplayUrl(url)), []);

  // Scale is updated dynamically via ResizeObserver
  useEffect(() => {
    (window as any).__oneagentBrowserScale = 0.5;
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    (window as any).activeWebview = webview;
    // webview methods (loadURL, executeJavaScript, ...) throw until the guest
    // has attached and fired dom-ready — gate tool calls on this flag.
    (window as any).activeWebviewReady = false;

    const updateEmulation = (width: number, height: number) => {
      const electronAPI = (window as any).electronAPI;
      if (!electronAPI?.browserEmulateDevice) return;
      
      const logicalWidth = 1280;
      const scale = width / logicalWidth;
      const logicalHeight = Math.round(height / scale);

      (window as any).__oneagentBrowserScale = scale;

      try {
        electronAPI.browserEmulateDevice(webview.getWebContentsId(), {
          screenPosition: 'desktop',
          screenSize: { width: logicalWidth, height: logicalHeight },
          viewPosition: { x: 0, y: 0 },
          viewSize: { width: logicalWidth, height: logicalHeight },
          scale: scale
        });
      } catch (e) {
        // webcontents might not be ready
      }
    };

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && webview.getWebContentsId) {
          updateEmulation(width, height);
        }
      }
    });

    const handleDomReady = () => {
      (window as any).activeWebviewReady = true;
      if (webview.parentElement) {
        resizeObserver.observe(webview.parentElement);
      }
      // Trigger initial
      if (webview.parentElement) {
        const rect = webview.parentElement.getBoundingClientRect();
        if (rect.width > 0) updateEmulation(rect.width, rect.height);
      }
    };

    const handleDidFinishLoad = () => {
      // A terminated session shows a frozen grayscale snapshot — don't let a
      // late did-finish-load from the dying page clear it.
      if (agentBrowserStore.getTerminatedSnapshot()) return;
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
        (window as any).activeWebviewReady = false;
      }
      webview.removeEventListener('dom-ready', handleDomReady);
      webview.removeEventListener('did-finish-load', handleDidFinishLoad);
      webview.removeEventListener('did-fail-load', handleDidFailLoad);
      resizeObserver.disconnect();
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
          allowpopups={"true" as any}
        />
      </div>
    </div>
  );
};

export default AgentBrowser;
