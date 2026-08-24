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

      {/* Persistent browser session. Mounted ONCE and never moved in the DOM
          (Electron webview guests tear down on reparenting). The Live Browser
          panel positions this layer over its slot via fixed coordinates; when
          hidden it parks off-screen at full size so tools keep working. */}
      <div
        id="oneagent-browser-layer"
        style={{ position: 'fixed', left: -20000, top: 0, width: 1280, height: 800, zIndex: 30 }}
      >
        <AgentBrowser />
      </div>
    </div>
  );
}

export default App;
