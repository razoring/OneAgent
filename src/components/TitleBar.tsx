import React from 'react';
import { Minus, Square, X } from 'lucide-react';

const TitleBar = () => {
  const handleMinimize = () => {
    if ((window as any).electronAPI) (window as any).electronAPI.minimize();
  };
  
  const handleMaximize = () => {
    if ((window as any).electronAPI) (window as any).electronAPI.maximize();
  };
  
  const handleClose = () => {
    if ((window as any).electronAPI) (window as any).electronAPI.close();
  };

  return (
    <div className="absolute top-0 left-0 right-0 h-10 drag-region z-50 flex items-center justify-between px-4">
      {/* Empty space for dragging */}
      <div className="flex-1 h-full flex items-center">
        {/* Optional App Title or Logo can go here */}
      </div>
      
      {/* Window Controls */}
      <div className="flex items-center gap-2 no-drag-region h-full pt-1">
        <button onClick={handleMinimize} className="p-1.5 text-textSecondary hover:bg-white/10 hover:text-white rounded transition-colors" title="Minimize">
          <Minus size={14} />
        </button>
        <button onClick={handleMaximize} className="p-1.5 text-textSecondary hover:bg-white/10 hover:text-white rounded transition-colors" title="Maximize">
          <Square size={12} />
        </button>
        <button onClick={handleClose} className="p-1.5 text-textSecondary hover:bg-white/10 hover:text-white rounded transition-colors" title="Close">
          <X size={16} />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
