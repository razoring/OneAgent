import { useState } from 'react';
import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import AgentBrowser from './components/AgentBrowser';
import RightSidebar from './components/RightSidebar';

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen w-screen bg-background text-white font-sans overflow-hidden">
      <TitleBar
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
      />
      <div className="flex flex-1 min-h-0">
        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${sidebarOpen ? 'w-[280px]' : 'w-0'}`}>
          <Sidebar />
        </div>
        <main className="flex-1 flex relative p-2 min-w-0">
          <ChatArea onToggleSettings={() => setRightSidebarOpen(o => !o)} />
        </main>
        <RightSidebar open={rightSidebarOpen} />
      </div>

      {/* Persistent browser session. Lives off-screen so agent tools work
          without any UI; the Live Browser panel moves this node into itself
          (appendChild — no remount) to make it visible. */}
      <div
        id="oneagent-browser-hidden"
        style={{ position: 'fixed', left: -20000, top: 0, width: 1280, height: 800, pointerEvents: 'none', zIndex: -1 }}
        aria-hidden
      >
        <AgentBrowser />
      </div>
    </div>
  );
}

export default App;
