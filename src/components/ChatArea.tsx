import React from 'react';
import ChatInput from './ChatInput';
import { ChevronDown } from 'lucide-react';

const ChatArea = () => {
  return (
    <div className="flex-1 flex flex-col bg-[#212121] relative">


      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 overflow-y-auto">
        <div className="flex flex-col items-center max-w-3xl w-full mt-10">
          <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-6">
            <img src="https://ollama.com/public/icon-64x64.png" alt="Ollama" className="w-10 h-10" onError={(e) => e.currentTarget.style.display = 'none'} />
          </div>
          <h1 className="text-3xl font-semibold text-gray-100 mb-12">How can I help you today?</h1>
        </div>
      </div>

      {/* Input Area */}
      <div className="w-full flex justify-center p-4 bg-gradient-to-t from-[#212121] via-[#212121] to-transparent pt-10">
        <div className="max-w-3xl w-full">
          <ChatInput />
          <div className="text-center text-xs text-gray-500 mt-3">
            AI models can make mistakes. Consider verifying important information.
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatArea;
