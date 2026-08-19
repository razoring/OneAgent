import React from 'react';
import { ChevronLeft, ChevronRight, RotateCw, Home, Shield } from 'lucide-react';

const BrowserShell = () => {
  return (
    <div className="w-[500px] border-l border-white/10 bg-black flex flex-col no-drag-region">
      {/* Browser Toolbar */}
      <div className="h-12 bg-surface flex items-center px-3 gap-2 border-b border-white/10 z-10 shadow-sm">
        <div className="flex items-center gap-1">
          <button className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md transition-colors"><ChevronLeft size={18}/></button>
          <button className="p-1.5 text-textSecondary/30 rounded-md"><ChevronRight size={18}/></button>
          <button className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md transition-colors"><RotateCw size={16}/></button>
        </div>
        
        <div className="flex-1 ml-2 flex items-center bg-black/40 border border-white/5 rounded-md px-3 py-1.5 gap-2">
          <Shield size={14} className="text-green-500" />
          <div className="text-sm text-textSecondary truncate font-medium">https://www.expedia.com</div>
        </div>

        <button className="p-1.5 text-textSecondary hover:text-white hover:bg-white/10 rounded-md transition-colors ml-1"><Home size={18}/></button>
      </div>

      {/* Browser Content Area Placeholder */}
      <div className="flex-1 relative bg-white flex items-center justify-center overflow-hidden">
        {/* Placeholder image of a website or a loading state */}
        <div className="absolute inset-0 bg-gray-100 flex flex-col items-center justify-center text-gray-400">
          <div className="h-12 w-12 border-4 border-gray-300 border-t-blue-500 rounded-full animate-spin mb-4"></div>
          <p className="font-medium text-sm">Loading webview...</p>
        </div>
        
        {/* Fake Set-of-Mark Overlay Demo */}
        <div className="absolute top-20 left-10 bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded shadow-sm border border-white/50">1</div>
        <div className="absolute top-20 right-32 bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded shadow-sm border border-white/50">2</div>
        <div className="absolute top-48 left-1/4 bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded shadow-sm border border-white/50">3</div>
      </div>
    </div>
  );
};

export default BrowserShell;
