import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

const proc = (window as any).process;
const isMac = proc?.platform === 'darwin';
const isWindows = proc?.platform === 'win32';

// Slim top strip hosting app-level buttons. Window controls are drawn by the
// OS: macOS traffic lights overlay the left edge, Windows titleBarOverlay
// renders native buttons on the right — so this bar reserves space for them
// (via env(titlebar-area-*)) and never implements window functions.
const TitleBar = ({ sidebarOpen, onToggleSidebar }: { sidebarOpen: boolean, onToggleSidebar?: () => void }) => {
  return (
    <div
      className="h-9 shrink-0 drag-region bg-background flex items-center gap-2 z-50 select-none"
      style={
        isWindows
          ? { paddingLeft: 'env(titlebar-area-x, 0px)', width: 'env(titlebar-area-width, 100%)' }
          : { paddingLeft: isMac ? '80px' : '12px', paddingRight: '12px' }
      }
    >
      {onToggleSidebar && (
        <button
          onClick={onToggleSidebar}
          className="no-drag-region p-1.5 rounded-full text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
          title={sidebarOpen ? 'Hide chat history' : 'Show chat history'}
        >
          {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
      )}
    </div>
  );
};

export default TitleBar;
