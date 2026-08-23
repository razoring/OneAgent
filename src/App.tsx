import { useState } from 'react';
import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';

function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex flex-col h-screen w-screen bg-background text-white font-sans overflow-hidden">
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(o => !o)} />
      <div className="flex flex-1 min-h-0">
        <div className={`overflow-hidden transition-all duration-300 ease-in-out ${sidebarOpen ? 'w-[280px]' : 'w-0'}`}>
          <Sidebar />
        </div>
        <main className="flex-1 flex relative p-2 min-w-0">
          <ChatArea />
        </main>
      </div>
    </div>
  );
}

export default App;
