import React, { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Shield } from 'lucide-react';
import { agentBrowserStore } from '../utils/agentBrowserStore';

// Live embedded browser driven by the agent's browser_* tools.
// Registers itself as window.activeWebview so browserTools.ts can drive it.
const AgentBrowser: React.FC = () => {
  const url = agentBrowserStore.getUrl();
  const [inputUrl, setInputUrl] = useState(url);
  const webviewRef = useRef<any>(null);

  useEffect(() => setInputUrl(url), [url]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    (window as any).activeWebview = webview;

    const handleDidFinishLoad = () => {
      const live = webview.getURL();
      setInputUrl(live);
      agentBrowserStore.navigate(live);
    };

    webview.addEventListener('did-finish-load', handleDidFinishLoad);
    return () => {
      if ((window as any).activeWebview === webview) {
        (window as any).activeWebview = null;
      }
      webview.removeEventListener('did-finish-load', handleDidFinishLoad);
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
          <span className="text-[11px] font-mono text-gray-300 truncate select-text">{inputUrl}</span>
        </div>
      </div>

      {/* Live page */}
      {/* @ts-ignore - webview is a custom element in Electron */}
      <webview
        ref={webviewRef}
        src={url}
        className="flex-1 w-full"
        partition="persist:oneagent_browser"
        webpreferences="contextIsolation=yes,javascript=yes"
      />
    </div>
  );
};

export default AgentBrowser;
