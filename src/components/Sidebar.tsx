import React, { useState } from 'react';
import { MessageSquarePlus, Settings, LayoutGrid } from 'lucide-react';
import SettingsModal from './SettingsModal';

const Sidebar = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  return (
    <div className="w-[280px] bg-[#171717] flex flex-col h-full border-r border-white/10 text-sm">
      {/* Top Section */}
      <div className="p-4">
        <button className="flex items-center gap-3 w-full mac-element mac-element-hover transition-all rounded-[28px] p-3.5 text-left font-medium text-white">
          <div className="bg-white/10 text-white p-1.5 rounded-full">
            <MessageSquarePlus size={18} />
          </div>
          New Chat
        </button>
      </div>

      {/* Chat History */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1.5">
        <div className="text-xs font-semibold text-gray-500 mb-3 px-2">Today</div>
        {['System Architecture Design', 'Ollama UI Setup'].map((chat, i) => (
          <button key={i} className={`w-full text-left p-3 rounded-2xl truncate transition-colors ${i === 0 ? 'bg-[#2f2f2f] text-white' : 'text-gray-300 hover:bg-[#212121]'}`}>
            {chat}
          </button>
        ))}
        
        <div className="text-xs font-semibold text-gray-500 mb-3 mt-5 px-2">Previous 7 Days</div>
        {['React Window Management', 'Tailwind CSS Downgrade', 'Vite Configuration Error'].map((chat, i) => (
          <button key={i} className="w-full text-left p-3 rounded-2xl truncate text-gray-300 hover:bg-[#212121] transition-colors">
            {chat}
          </button>
        ))}
      </div>

      {/* Bottom Section */}
      <div className="p-4 border-t border-white/10 space-y-1.5">
        <button className="flex items-center gap-3 w-full hover:bg-[#2f2f2f] transition-colors rounded-2xl p-3 text-left text-gray-300">
          <LayoutGrid size={18} />
          Models
        </button>
        <button 
          onClick={() => setIsSettingsOpen(true)}
          className="flex items-center gap-3 w-full hover:bg-[#2f2f2f] transition-colors rounded-2xl p-3 text-left text-gray-300"
        >
          <Settings size={18} />
          Settings
        </button>
      </div>

      {isSettingsOpen && (
        <SettingsModal onClose={() => setIsSettingsOpen(false)} />
      )}
    </div>
  );
};

export default Sidebar;
