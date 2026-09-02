import { useState, useEffect } from 'react';
import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import RightSidebar from './components/RightSidebar';
import BrowserChrome from './components/BrowserChrome';

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [standaloneMode, setStandaloneMode] = useState(false);

  useEffect(() => {
    const handleStandalone = () => setStandaloneMode(true);
    window.addEventListener('enter-standalone-browser', handleStandalone as EventListener);
    return () => {
      window.removeEventListener('enter-standalone-browser', handleStandalone as EventListener);
    };
  }, []);

  const handleExitStandalone = async () => {
    const api: any = (window as any).electronAPI;
    if (api?.standaloneLeave) await api.standaloneLeave().catch(()=>{});
    setStandaloneMode(false);
  };

  if (standaloneMode) {
    return (
      <div className="flex flex-col h-screen w-screen bg-background text-white font-sans overflow-hidden">
        <BrowserChrome agentId="__standalone__" onExit={handleExitStandalone} />
      </div>
    );
  }

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
    </div>
  );
}

export default App;
