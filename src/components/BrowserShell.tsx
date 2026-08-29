import React, { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Home, Shield } from 'lucide-react';

// DEPRECATED: <webview>-based shell replaced by AgentBrowser + WebContentsView.
// Kept for reference only — not mounted anywhere. Use AgentBrowser for the
// unified tab substrate (correct Z, viewport-relative bounds, parallel agents).
const BrowserShell = () => {
  const [url, setUrl] = useState('https://html.duckduckgo.com/');
  const [inputUrl, setInputUrl] = useState(url);
  const webviewRef = useRef<any>(null);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    
    (window as any).activeWebview = webview;

    const handleDidFinishLoad = () => {
      setInputUrl(webview.getURL());
    };

    webview.addEventListener('did-finish-load', handleDidFinishLoad);
    return () => {
      if ((window as any).activeWebview === webview) {
        (window as any).activeWebview = null;
      }
      webview.removeEventListener('did-finish-load', handleDidFinishLoad);
    };
  }, []);

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault();
    let target = inputUrl.trim();
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      if (target.includes('.') && !target.includes(' ')) {
        target = 'https://' + target;
      } else {
        target = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(target);
      }
    }
    setUrl(target);
  };

  const goBack = () => webviewRef.current?.goBack();
  const goForward = () => webviewRef.current?.goForward();
  const reload = () => webviewRef.current?.reload();
  const goHome = () => setUrl('https://html.duckduckgo.com/');

  return (
    <div className="w-[500px] bg-black flex flex-col no-drag-region">
      {/* Browser Toolbar */}
      <div className="h-12 bg-surface flex items-center px-3 gap-2 border-b border-white/10 z-10 shadow-sm">
        <div className="flex items-center gap-1">
          <button onClick={goBack} className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md transition-colors"><ChevronLeft size={18}/></button>
          <button onClick={goForward} className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md transition-colors"><ChevronRight size={18}/></button>
          <button onClick={reload} className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md transition-colors"><RotateCw size={16}/></button>
        </div>
        
        <form onSubmit={handleNavigate} className="flex-1 ml-2 flex items-center bg-black/40 border border-white/5 rounded-md px-3 py-1.5 gap-2 focus-within:ring-1 focus-within:ring-accent focus-within:border-accent">
          <Shield size={14} className="text-accentBright" />
          <input 
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            className="flex-1 bg-transparent border-none outline-none text-sm text-gray-200 font-medium"
            placeholder="Search or enter URL"
          />
        </form>

        <button onClick={goHome} className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md transition-colors ml-1"><Home size={18}/></button>
      </div>

      {/* Browser Content Area */}
      <div className="flex-1 relative bg-white flex flex-col overflow-hidden">
        {/* @ts-ignore - webview is a custom element in Electron */}
        <webview
          ref={webviewRef}
          src={url}
          className="flex-1 w-full h-full"
          partition="persist:oneagent_browser"
          webpreferences="contextIsolation=yes,javascript=yes"
        />
      </div>
    </div>
  );
};

export default BrowserShell;
