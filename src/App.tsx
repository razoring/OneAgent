import React from 'react';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';

function App() {
  return (
    <div className="flex h-screen w-screen bg-[#171717] text-white font-sans overflow-hidden">
      <Sidebar />
      <main className="flex-1 flex relative">
        <ChatArea />
      </main>
    </div>
  );
}

export default App;
