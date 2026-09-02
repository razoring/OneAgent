import { useState } from 'react';
import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
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
        <div className={`overflow-hidden transition-all duration-300 ease-in-out flex-shrink-0 ${sidebarOpen ? 'w-[280px]' : 'w-0'}`}>
          <Sidebar />
        </div>
        
        <main className="flex-1 flex relative p-2 min-w-0">
          <div className="flex-1 min-w-0 flex flex-col border border-white/5 bg-black/10 rounded-xl overflow-hidden shadow-2xl">
            <ChatArea onToggleSettings={() => setRightSidebarOpen(o => !o)} />
          </div>
        </main>
        
        <RightSidebar open={rightSidebarOpen} />
      </div>

      {/* External Chromium via CDP (live profile) — no embedded webview. Browser button in sidebar launches Chrome with --remote-debugging-port. */}
    </div>
  );
}

export default App;
