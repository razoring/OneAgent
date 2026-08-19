import React from 'react';
import { ArrowUp, Paperclip } from 'lucide-react';

const ChatInput = () => {
  return (
    <div className="relative w-full bg-[#2f2f2f] rounded-2xl border border-white/5 focus-within:border-white/20 focus-within:ring-1 focus-within:ring-white/20 transition-all shadow-md">
      <div className="flex items-end p-2">
        <button className="p-2.5 text-gray-400 hover:text-white rounded-xl hover:bg-white/5 transition-colors mb-0.5">
          <Paperclip size={20} />
        </button>
        
        <textarea 
          placeholder="Message..."
          className="flex-1 bg-transparent border-none outline-none text-gray-100 placeholder-gray-500 min-h-[44px] max-h-[200px] py-3 px-2 resize-none leading-relaxed"
          rows={1}
        />
        
        <button className="p-2 bg-white text-black rounded-xl hover:bg-gray-200 transition-colors mb-0.5 ml-2 disabled:opacity-50">
          <ArrowUp size={20} strokeWidth={3} />
        </button>
      </div>
    </div>
  );
};

export default ChatInput;
