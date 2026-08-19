import React from 'react';
import { MessageSquarePlus, Settings, LayoutGrid } from 'lucide-react';

const Sidebar = () => {
  return (
    <div className="w-[260px] bg-[#171717] flex flex-col h-full border-r border-white/10 text-sm">
      {/* Top Section */}
      <div className="p-3">
        <button className="flex items-center gap-2 w-full hover:bg-[#2f2f2f] transition-colors rounded-lg p-2.5 text-left font-medium">
          <div className="bg-white text-black p-1 rounded">
            <MessageSquarePlus size={16} />
          </div>
          New Chat
        </button>
      </div>

      {/* Chat History */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        <div className="text-xs font-semibold text-gray-500 mb-2 px-2">Today</div>
        {['System Architecture Design', 'Ollama UI Setup'].map((chat, i) => (
          <button key={i} className={`w-full text-left p-2.5 rounded-lg truncate ${i === 0 ? 'bg-[#2f2f2f] text-white' : 'text-gray-300 hover:bg-[#212121]'}`}>
            {chat}
          </button>
        ))}
        
        <div className="text-xs font-semibold text-gray-500 mb-2 mt-4 px-2">Previous 7 Days</div>
        {['React Window Management', 'Tailwind CSS Downgrade', 'Vite Configuration Error'].map((chat, i) => (
          <button key={i} className="w-full text-left p-2.5 rounded-lg truncate text-gray-300 hover:bg-[#212121]">
            {chat}
          </button>
        ))}
      </div>

      {/* Bottom Section */}
      <div className="p-3 border-t border-white/10">
        <button className="flex items-center gap-2 w-full hover:bg-[#2f2f2f] transition-colors rounded-lg p-2.5 text-left text-gray-300">
          <LayoutGrid size={16} />
          Models
        </button>
        <button className="flex items-center gap-2 w-full hover:bg-[#2f2f2f] transition-colors rounded-lg p-2.5 text-left text-gray-300 mt-1">
          <Settings size={16} />
          Settings
        </button>
      </div>
    </div>
  );
};

export default Sidebar;
