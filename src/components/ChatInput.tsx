import React, { useState, useRef, useEffect } from 'react';
import { ArrowUp, ChevronUp, Plus, FileText, Image as ImageIcon, Folder, X } from 'lucide-react';

const PROVIDER_ICONS: Record<string, string> = {
  ollama: 'https://ollama.com/public/icon-64x64.png',
  lmstudio: 'https://lmstudio.ai/favicon.ico',
  openrouter: 'https://openrouter.ai/favicon.ico',
  openai: 'https://upload.wikimedia.org/wikipedia/commons/0/04/ChatGPT_logo.svg'
};

const RECENT_MODELS = [
  { id: 'llama3.1:latest', name: 'llama3.1:latest', provider: 'ollama' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
];

const ALL_MODELS = [
  { id: 'llama3.1:latest', name: 'llama3.1:latest', provider: 'ollama' },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
  { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'openrouter' },
  { id: 'mixtral-8x7b', name: 'mixtral-8x7b', provider: 'lmstudio' },
];

const MOCK_FILES = [
  { id: '1', display: 'financial_report_Q3.pdf', type: 'file' },
  { id: '2', display: 'architecture_diagram.png', type: 'image' },
  { id: '3', display: 'src_folder', type: 'folder' }
];

const ModelItem = ({ model, isSelected, onClick }: { model: any, isSelected: boolean, onClick: () => void }) => (
  <button 
    onClick={onClick}
    className={`flex items-center gap-3 w-full text-left px-4 py-2.5 rounded-xl text-sm transition-colors ${
      isSelected 
        ? 'bg-white/10 text-white font-medium' 
        : 'text-gray-300 hover:bg-white/5 hover:text-white'
    }`}
  >
    <img 
      src={PROVIDER_ICONS[model.provider] || PROVIDER_ICONS['ollama']} 
      alt={model.provider} 
      className="w-5 h-5 rounded object-contain bg-white/10 p-0.5" 
      onError={(e) => e.currentTarget.style.display = 'none'} 
    />
    <span className="truncate">{model.name}</span>
  </button>
);

const ChatInput = () => {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(RECENT_MODELS[0]);
  
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<any[]>(MOCK_FILES); // Pre-load for testing

  const editorRef = useRef<HTMLDivElement>(null);
  
  // Mentions State
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionRange, setMentionRange] = useState<Range | null>(null);
  const [focusedMentionIndex, setFocusedMentionIndex] = useState(0);

  useEffect(() => {
    setFocusedMentionIndex(0);
  }, [mentionQuery, isMentionMenuOpen]);

  const handleAttach = (file: any) => {
    if (!attachments.find(a => a.id === file.id)) {
      setAttachments([...attachments, file]);
    }
    setIsAttachMenuOpen(false);
  };

  const removeAttachment = (id: string) => {
    setAttachments(attachments.filter(a => a.id !== id));
  };

  const getFileIcon = (type: string) => {
    switch (type) {
      case 'image': return <ImageIcon size={24} className="text-blue-400" />;
      case 'folder': return <Folder size={24} className="text-yellow-400" />;
      default: return <FileText size={24} className="text-red-400" />;
    }
  };

  const getFileIconSmall = (type: string) => {
    switch (type) {
      case 'image': return <ImageIcon size={14} className="text-blue-400" />;
      case 'folder': return <Folder size={14} className="text-yellow-400" />;
      default: return <FileText size={14} className="text-red-400" />;
    }
  };

  const handleInput = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const textBeforeCaret = range.startContainer.textContent?.slice(0, range.startOffset) || '';

    // Match @ followed by characters at the end
    const match = textBeforeCaret.match(/(?:^|\s)@([^\s]*)$/);

    if (match && attachments.length > 0) {
      setMentionQuery(match[1].toLowerCase());
      setMentionRange(range.cloneRange());
      setIsMentionMenuOpen(true);
    } else {
      setIsMentionMenuOpen(false);
    }
  };

  const filteredAttachments = attachments.filter(a => a.display.toLowerCase().includes(mentionQuery));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isMentionMenuOpen && filteredAttachments.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedMentionIndex((prev) => (prev + 1) % filteredAttachments.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusedMentionIndex((prev) => (prev - 1 + filteredAttachments.length) % filteredAttachments.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        insertMention(filteredAttachments[focusedMentionIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setIsMentionMenuOpen(false);
      }
    }
  };

  const insertMention = (att: any) => {
    if (!mentionRange) return;

    const selection = window.getSelection();
    if (!selection) return;

    // Calculate how many characters to delete ("@" + query)
    const charsToDelete = mentionQuery.length + 1;
    
    // Adjust the range to encompass the "@query" text
    mentionRange.setStart(mentionRange.startContainer, Math.max(0, mentionRange.startOffset - charsToDelete));
    mentionRange.deleteContents();

    // Create the immutable chip element
    const chip = document.createElement('span');
    chip.contentEditable = 'false';
    chip.className = 'inline-flex items-center gap-1.5 bg-white/10 border border-white/5 text-blue-400 px-2 h-[24px] rounded-md mx-1 align-middle select-none shadow-sm cursor-pointer hover:underline -my-2';
    chip.dataset.id = att.id;
    chip.onclick = () => {
      // Placeholder for opening or previewing the attachment
      console.log('Preview attachment:', att.display);
    };
    
    // Convert React lucide icon to static SVG string or simple text for the DOM element
    const iconSpan = document.createElement('span');
    iconSpan.className = 'flex items-center';
    iconSpan.innerHTML = att.type === 'image' ? '🖼️' : att.type === 'folder' ? '📁' : '📄';
    chip.appendChild(iconSpan);
    
    const textSpan = document.createElement('span');
    textSpan.className = 'text-[13px] font-medium leading-none';
    textSpan.textContent = att.display;
    chip.appendChild(textSpan);

    // Insert the chip
    mentionRange.insertNode(chip);
    
    // Insert a non-breaking space after the chip so the user can keep typing
    const space = document.createTextNode('\u00A0');
    chip.parentNode?.insertBefore(space, chip.nextSibling);

    // Move caret after the space
    mentionRange.setStartAfter(space);
    mentionRange.collapse(true);
    
    selection.removeAllRanges();
    selection.addRange(mentionRange);

    setIsMentionMenuOpen(false);
    
    // Refocus editor
    editorRef.current?.focus();
  };

  return (
    <div className="relative w-full rounded-[28px] mac-element transition-all focus-within:ring-2 focus-within:ring-white/20 p-4 flex flex-col gap-3 shadow-lg">
      
      {/* Attachments Preview Row */}
      {attachments.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            {attachments.map(att => (
              <div key={att.id} className="relative group flex flex-col items-center gap-1.5 w-16">
                <div className="relative w-14 h-14 rounded-[20px] mac-element flex items-center justify-center bg-black/20 overflow-hidden">
                  {getFileIcon(att.type)}
                  
                  {/* Remove Overlay */}
                  <button 
                    onClick={() => removeAttachment(att.id)}
                    className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white"
                  >
                    <X size={20} />
                  </button>
                </div>
                <span className="text-[10px] text-gray-400 truncate w-full text-center">{att.display}</span>
              </div>
            ))}
          </div>
          <div className="h-px w-full bg-white/10" />
        </div>
      )}

      {/* Mention Dropdown Menu (Full Width Drop-up) */}
      {isMentionMenuOpen && filteredAttachments.length > 0 && (
        <div className="absolute bottom-full left-0 w-full z-50 mb-3">
          <div className="mac-element rounded-[24px] p-2 flex flex-col shadow-2xl max-h-[200px] overflow-y-auto">
            <div className="text-xs font-semibold text-gray-500 px-3 pt-2 pb-2 uppercase tracking-wider">Mentions</div>
            {filteredAttachments.map((att, i) => (
              <button 
                key={att.id}
                onClick={() => insertMention(att)}
                className={`flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-2xl text-sm transition-colors ${
                  i === focusedMentionIndex ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                {getFileIconSmall(att.type)}
                <span className="truncate">{att.display}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Custom ContentEditable Input */}
      <div 
        ref={editorRef}
        contentEditable
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        className="w-full min-h-[44px] max-h-[240px] overflow-y-auto px-2 py-1 relative z-10 text-[15px] leading-8 text-gray-100 outline-none cursor-text empty:before:content-['Message...'] empty:before:text-gray-500"
      />
      
      {/* Bottom Toolbar Row */}
      <div className="flex items-center justify-between mt-1 px-1">
        
        {/* Left Actions: Attach & Model Selector */}
        <div className="flex items-center gap-3 relative">
          
          {/* Attach Button Drop-up */}
          <div className="relative">
            {isAttachMenuOpen && (
              <div className="absolute bottom-full left-0 mb-3 w-56 mac-element rounded-[24px] p-2 z-50 flex flex-col shadow-2xl">
                <button onClick={() => handleAttach(MOCK_FILES[0])} className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-2xl text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors">
                  <FileText size={18} className="text-red-400" />
                  Attach PDF Report
                </button>
                <button onClick={() => handleAttach(MOCK_FILES[1])} className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-2xl text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors">
                  <ImageIcon size={18} className="text-blue-400" />
                  Attach Image
                </button>
                <div className="h-px bg-white/10 my-1 mx-2"></div>
                <button onClick={() => handleAttach(MOCK_FILES[2])} className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-2xl text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors">
                  <Folder size={18} className="text-yellow-400" />
                  Upload Folder
                </button>
              </div>
            )}
            <button 
              onClick={() => setIsAttachMenuOpen(!isAttachMenuOpen)}
              className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-white/10 transition-all" 
              title="Attach file"
            >
              <Plus size={20} className={`transition-transform duration-200 ${isAttachMenuOpen ? 'rotate-45' : ''}`} />
            </button>
          </div>
          
          {/* Model Selector Drop-up */}
          <div className="relative">
            {isModelMenuOpen && (
              <div className="absolute bottom-full left-0 mb-3 w-64 mac-element rounded-[24px] p-2 z-50 flex flex-col shadow-2xl">
                
                <div className="text-xs font-semibold text-gray-500 px-3 pt-3 pb-2 uppercase tracking-wider">Recent Models</div>
                {RECENT_MODELS.map((model) => (
                  <ModelItem 
                    key={`recent-${model.id}`} 
                    model={model} 
                    isSelected={selectedModel.id === model.id} 
                    onClick={() => { setSelectedModel(model); setIsModelMenuOpen(false); }} 
                  />
                ))}

                <div className="h-px bg-white/10 my-2 mx-2"></div>

                <div className="text-xs font-semibold text-gray-500 px-3 pt-2 pb-2 uppercase tracking-wider">All Models</div>
                {ALL_MODELS.filter(m => !RECENT_MODELS.some(r => r.id === m.id)).map((model) => (
                  <ModelItem 
                    key={`all-${model.id}`} 
                    model={model} 
                    isSelected={selectedModel.id === model.id} 
                    onClick={() => { setSelectedModel(model); setIsModelMenuOpen(false); }} 
                  />
                ))}
              </div>
            )}
            
            <button 
              onClick={() => setIsModelMenuOpen(!isModelMenuOpen)}
              className="flex items-center gap-2.5 px-3.5 py-2 rounded-2xl mac-element mac-element-hover text-gray-200 font-medium text-sm transition-all"
            >
              <img 
                src={PROVIDER_ICONS[selectedModel.provider] || PROVIDER_ICONS['ollama']} 
                alt={selectedModel.provider} 
                className="w-4 h-4 rounded-sm object-contain" 
                onError={(e) => e.currentTarget.style.display = 'none'} 
              />
              {selectedModel.name}
              <ChevronUp size={16} className={`transition-transform ml-1 ${isModelMenuOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>

        </div>

        {/* Right Action: Send Button */}
        <button className="p-2 bg-white text-black rounded-full hover:bg-gray-200 transition-colors disabled:opacity-50" title="Send message">
          <ArrowUp size={20} strokeWidth={3} />
        </button>
        
      </div>
    </div>
  );
};

export default ChatInput;
