import { useState, useEffect } from 'react';
import { PanelLeftClose, PanelLeftOpen, ChevronLeft, Bug, Settings2 } from 'lucide-react';
import { titleBarBridge, TitleBarState } from '../utils/titleBarBridge';

const proc = (window as any).process;
const isMac = proc?.platform === 'darwin';
const isWindows = proc?.platform === 'win32';

// Slim top strip hosting app-level buttons. Window controls are drawn by the
// OS: macOS traffic lights overlay the left edge, Windows titleBarOverlay
// renders native buttons on the right — so this bar reserves space for them
// (via env(titlebar-area-*)) and never implements window functions.
// The active chat's title (and its actions) are mirrored here via titleBarBridge.
const TitleBar = ({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean, onToggleSidebar?: () => void }) => {
  const [tb, setTb] = useState<TitleBarState>(titleBarBridge.get());
  useEffect(() => titleBarBridge.subscribe(setTb), []);

  return (
    <div
      className="h-9 shrink-0 drag-region bg-background flex items-center gap-2 z-50 select-none relative"
      style={
        isWindows
          ? { paddingLeft: 'env(titlebar-area-x, 0px)', width: 'env(titlebar-area-width, 100%)' }
          : { paddingLeft: isMac ? '80px' : '12px', paddingRight: '12px' }
      }
    >
      <div className="flex items-center gap-1 min-w-0">
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="no-drag-region p-1.5 rounded-full text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
            title={sidebarOpen ? 'Hide chat history' : 'Show chat history'}
          >
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        )}
        {tb.canReturn && (
          <button
            onClick={tb.onReturn}
            className="no-drag-region flex items-center gap-1 text-textSecondary hover:text-white transition-colors bg-white/5 hover:bg-white/10 px-2.5 py-1 rounded-full text-xs font-semibold"
            title="Return to parent chat"
          >
            <ChevronLeft size={14} />
            Return
          </button>
        )}
      </div>

      {/* Centered chat title */}
      <div className="absolute left-1/2 -translate-x-1/2 pointer-events-none">
        {tb.title && (
          <span className="text-sm font-semibold text-white/80 truncate max-w-[300px] inline-block">
            {tb.title}
          </span>
        )}
      </div>

      {/* Right-side actions */}
      <div className="ml-auto flex items-center gap-1">
        {tb.showTranscript && (
          <button
            onClick={tb.onDownloadTranscript}
            className="no-drag-region p-1.5 rounded-full text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
            title="Download debug transcript"
          >
            <Bug size={15} />
          </button>
        )}
        {tb.showSettings && (
          <button
            onClick={tb.onToggleSettings}
            className="no-drag-region p-1.5 rounded-full text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
            title="Model parameters"
          >
            <Settings2 size={15} />
          </button>
        )}
      </div>
    </div>
  );
};

export default TitleBar;
