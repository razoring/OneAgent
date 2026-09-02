import React, { useState, useEffect } from 'react';
import { browserPreviewStore } from '../utils/browserPreviewStore';

export default function ScreenshotCarousel({ agentId, chatId }: { agentId: string, chatId: string }) {
  const [images, setImages] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const updateImages = () => {
      const latest = browserPreviewStore.getImages(agentId);
      setImages(prev => {
        if (prev.length === latest.length && prev.every((img, i) => img === latest[i])) {
          return prev;
        }
        return latest;
      });
    };
    updateImages();
    const unsub = browserPreviewStore.subscribe(updateImages);
    return () => { unsub(); };
  }, [agentId]);

  // When a new image is added, automatically scroll to the latest one
  useEffect(() => {
    if (images.length > 0) {
      setCurrentIndex(images.length - 1);
    }
  }, [images.length]);

  const handleTakeControl = async () => {
    const api: any = (window as any).electronAPI;
    if (api && api.takeControl) {
      await api.takeControl(agentId);
      window.dispatchEvent(new CustomEvent('enter-browser-mode', { detail: agentId }));
    }
  };

  if (images.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-textSecondary/50 font-medium">
        No browser activity yet
      </div>
    );
  }

  return (
    <div className="relative flex-1 bg-black/50 overflow-hidden flex flex-col group">
      <div className="flex-1 relative flex items-center justify-center p-4">
        <img 
          src={images[currentIndex]} 
          alt={`Screenshot ${currentIndex + 1}`} 
          className="max-w-full max-h-full object-contain rounded border border-white/10 shadow-xl"
        />
        
        {/* Hover Overlay */}
        <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <button 
            onClick={handleTakeControl}
            className="px-6 py-3 bg-accent text-white rounded-xl font-medium text-lg hover:bg-accent/90 transform hover:scale-105 transition-all shadow-xl flex items-center gap-2"
          >
            Take Control
          </button>
        </div>
      </div>
      
      {/* Controls */}
      {images.length > 1 && (
        <div className="absolute bottom-4 left-0 right-0 flex justify-center items-center gap-4 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
          <button 
            onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
            className="w-10 h-10 rounded-full bg-black/80 border border-white/10 text-white flex items-center justify-center hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            ←
          </button>
          <div className="px-4 py-1.5 rounded-full bg-black/80 border border-white/10 text-xs font-mono text-white shadow-lg font-bold">
            {currentIndex + 1} / {images.length}
          </div>
          <button 
            onClick={() => setCurrentIndex(i => Math.min(images.length - 1, i + 1))}
            disabled={currentIndex === images.length - 1}
            className="w-10 h-10 rounded-full bg-black/80 border border-white/10 text-white flex items-center justify-center hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
