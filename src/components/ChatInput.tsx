import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowUp, ChevronUp, Plus, FileText, Image as ImageIcon, Folder, X, FileSpreadsheet, MonitorPlay, AlertTriangle, Square } from 'lucide-react';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin, ViewUpdate, keymap } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

const PROVIDER_ICONS: Record<string, string> = {
  ollama: 'https://ollama.com/public/icon-64x64.png',
  lmstudio: 'https://lmstudio.ai/favicon.ico',
  openrouter: 'https://openrouter.ai/favicon.ico',
  openai: 'https://upload.wikimedia.org/wikipedia/commons/0/04/ChatGPT_logo.svg',
  gemini: 'https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg',
  groq: 'https://groq.com/favicon.ico',
  together: 'https://www.together.ai/favicon.ico',
  anthropic: 'https://www.anthropic.com/favicon.ico'
};

import { LLMModel, fetchModels } from '../utils/llm';

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

interface ChatInputProps {
  onSend: (text: string, attachments: any[], model: LLMModel) => void;
  onStop?: () => void;
  disabled?: boolean;
}

class MentionWidget extends WidgetType {
  constructor(public text: string, public attachment: any) {
    super();
  }
  eq(other: MentionWidget) {
    return this.text === other.text && this.attachment?.id === other.attachment?.id;
  }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'inline-flex items-center gap-1.5 bg-white/10 border border-white/5 text-blue-400 px-2 h-[24px] rounded-md mx-1 align-middle select-none shadow-sm cursor-pointer hover:underline -my-2';
    
    const iconSpan = document.createElement('span');
    iconSpan.className = 'flex items-center text-current';
    iconSpan.style.width = '14px';
    iconSpan.style.height = '14px';
    if (this.attachment?.thumbnail) {
      iconSpan.innerHTML = `<img src="${this.attachment.thumbnail}" style="width:14px; height:14px; object-fit:contain;" />`;
    } else {
      const type = this.attachment?.type || 'file';
      iconSpan.innerHTML = type === 'image' ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>` : 
                           type === 'folder' ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>` :
                           `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;
    }
    span.appendChild(iconSpan);
    
    const textSpan = document.createElement('span');
    textSpan.className = 'text-[13px] font-medium leading-none';
    textSpan.textContent = this.text.substring(1); // remove @
    span.appendChild(textSpan);
    
    if (this.attachment) {
      span.onclick = () => {
        if (this.attachment.type === 'link' || (!this.attachment.file && this.attachment.url && this.attachment.url.startsWith('http'))) {
          if ((window as any).require) {
            const { shell } = (window as any).require('electron');
            shell.openExternal(this.attachment.url);
          } else {
            window.open(this.attachment.url, '_blank');
          }
        } else {
          span.dispatchEvent(new CustomEvent('preview-attachment', { detail: this.attachment.id, bubbles: true }));
        }
      };
    }
    return span;
  }
}

export function createMentionPlugin(getAttachments: () => any[]) {
  const mentionDecoration = (match: RegExpExecArray, attachments: any[]) => {
    const text = match[0];
    const filename = text.substring(1);
    const attachment = attachments.find(a => a.display === filename);
    if (attachment) {
      return Decoration.replace({
        widget: new MentionWidget(text, attachment)
      });
    }
    return null;
  };

  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }
    update(update: ViewUpdate) {
      this.decorations = this.buildDecorations(update.view);
    }
    buildDecorations(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      const attachments = getAttachments();
      if (attachments.length === 0) return builder.finish();

      for (let {from, to} of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        const regex = /@([^\s]+)/g;
        let match;
        while ((match = regex.exec(text))) {
          const dec = mentionDecoration(match, attachments);
          if (dec) {
            builder.add(from + match.index, from + match.index + match[0].length, dec);
          }
        }
      }
      return builder.finish();
    }
  }, {
    decorations: v => v.decorations
  });
}

const editorTheme = EditorView.theme({
  "&": {
    color: "#f3f4f6",
    backgroundColor: "transparent !important",
    fontSize: "15px",
    lineHeight: "2rem",
    width: "100%",
  },
  ".cm-content": {
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    padding: "0",
    color: "#f3f4f6",
    caretColor: "#ffffff",
  },
  ".cm-line": {
    color: "#f3f4f6",
  },
  "&.cm-focused": {
    outline: "none !important",
  },
  ".cm-cursor": {
    borderLeftColor: "#f3f4f6",
  },
  ".cm-placeholder": {
    color: "#6b7280",
  },
  ".cm-scroller": {
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    overflow: "hidden",
    backgroundColor: "transparent !important",
  }
}, { dark: true });

const ChatInput: React.FC<ChatInputProps> = ({ onSend, onStop, disabled }) => {
  const [value, setValue] = useState('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [allModels, setAllModels] = useState<LLMModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<LLMModel | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  
  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [previewAttachment, setPreviewAttachment] = useState<any | null>(null);
  const [attachmentToRemove, setAttachmentToRemove] = useState<string | null>(null);

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef(attachments);

  useEffect(() => {
    attachmentsRef.current = attachments;
    //force codemirror to re-evaluate decorations without triggering react state
    if (cmRef.current?.view) {
      requestAnimationFrame(() => {
        cmRef.current?.view?.dispatch();
      });
    }
  }, [attachments]);

  const loadModels = async () => {
    setIsLoadingModels(true);
    try {
      const models = await fetchModels();
      setAllModels(models);
      if (models.length > 0) {
        setSelectedModel(prev => prev && models.some(m => m.id === prev.id) ? prev : models[0]);
      } else {
        setSelectedModel(null);
      }
    } finally {
      setIsLoadingModels(false);
    }
  };

  useEffect(() => {
    loadModels();
    window.addEventListener('providers-updated', loadModels);
    return () => window.removeEventListener('providers-updated', loadModels);
  }, []);

  useEffect(() => {
    const handlePreview = (e: any) => {
      const att = attachmentsRef.current.find(a => a.id === e.detail);
      if (att) setPreviewAttachment(att);
    };
    document.addEventListener('preview-attachment', handlePreview);
    return () => document.removeEventListener('preview-attachment', handlePreview);
  }, []);
  
  // Mentions State
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionRange, setMentionRange] = useState<{from: number, to: number} | null>(null);
  const [focusedMentionIndex, setFocusedMentionIndex] = useState(0);

  useEffect(() => {
    setFocusedMentionIndex(0);
  }, [mentionQuery, isMentionMenuOpen]);

  const filteredAttachments = attachments.filter(a => a.display.toLowerCase().includes(mentionQuery));

  // Refs for keymap closures
  const isMentionMenuOpenRef = useRef(isMentionMenuOpen);
  useEffect(() => { isMentionMenuOpenRef.current = isMentionMenuOpen; }, [isMentionMenuOpen]);
  
  const focusedMentionIndexRef = useRef(focusedMentionIndex);
  useEffect(() => { focusedMentionIndexRef.current = focusedMentionIndex; }, [focusedMentionIndex]);

  const filteredAttachmentsRef = useRef(filteredAttachments);
  useEffect(() => { filteredAttachmentsRef.current = filteredAttachments; }, [filteredAttachments]);

  const mentionRangeRef = useRef(mentionRange);
  useEffect(() => { mentionRangeRef.current = mentionRange; }, [mentionRange]);

  const insertMention = useCallback((att: any) => {
    if (!mentionRangeRef.current) return;
    const view = cmRef.current?.view;
    if (view) {
      const insertText = `@${att.display} `;
      view.dispatch({
        changes: {
          from: mentionRangeRef.current.from,
          to: mentionRangeRef.current.to,
          insert: insertText
        },
        selection: { anchor: mentionRangeRef.current.from + insertText.length }
      });
      view.focus();
    }
    setIsMentionMenuOpen(false);
  }, []);

  const handleSend = useCallback(() => {
    if (disabled || !selectedModel || (!value.trim() && attachmentsRef.current.length === 0)) return;
    onSend(value, attachmentsRef.current, selectedModel);
    setValue('');
    setAttachments([]);
  }, [disabled, selectedModel, value, onSend]);

  const customKeymap = keymap.of([
    {
      key: 'ArrowDown',
      run: () => {
        if (isMentionMenuOpenRef.current && filteredAttachmentsRef.current.length > 0) {
          setFocusedMentionIndex(prev => (prev + 1) % filteredAttachmentsRef.current.length);
          return true;
        }
        return false;
      }
    },
    {
      key: 'ArrowUp',
      run: () => {
        if (isMentionMenuOpenRef.current && filteredAttachmentsRef.current.length > 0) {
          setFocusedMentionIndex(prev => (prev - 1 + filteredAttachmentsRef.current.length) % filteredAttachmentsRef.current.length);
          return true;
        }
        return false;
      }
    },
    {
      key: 'Escape',
      run: () => {
        if (isMentionMenuOpenRef.current) {
          setIsMentionMenuOpen(false);
          return true;
        }
        return false;
      }
    },
    {
      key: 'Enter',
      run: () => {
        if (isMentionMenuOpenRef.current && filteredAttachmentsRef.current.length > 0) {
          insertMention(filteredAttachmentsRef.current[focusedMentionIndexRef.current]);
          return true;
        } else if (!isMentionMenuOpenRef.current) {
          handleSend();
          return true;
        }
        return false;
      },
      shift: () => false // allow newline
    }
  ]);

  const handleUpdate = useCallback((update: ViewUpdate) => {
    if (update.docChanged) {
      setValue(update.state.doc.toString());
    }
    const state = update.state;
    const selection = state.selection.main;
    if (selection.empty) {
      const pos = selection.head;
      const line = state.doc.lineAt(pos);
      const textBefore = line.text.slice(0, pos - line.from);
      const match = textBefore.match(/(?:^|\s)@([^\s]*)$/);
      if (match && attachmentsRef.current.length > 0) {
        const newQuery = match[1].toLowerCase();
        const newFrom = pos - match[1].length - 1;
        const newTo = pos;

        setMentionQuery(prev => prev === newQuery ? prev : newQuery);
        setMentionRange(prev => (prev && prev.from === newFrom && prev.to === newTo) ? prev : { from: newFrom, to: newTo });
        setIsMentionMenuOpen(prev => prev ? prev : true);
      } else {
        setIsMentionMenuOpen(prev => !prev ? prev : false);
      }
    } else {
      setIsMentionMenuOpen(prev => !prev ? prev : false);
    }
  }, []);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };
  
  const processFiles = async (files: File[]) => {
    const newAttachments = await Promise.all(files.map(async file => {
      const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name);
      let thumbnail = null;
      if ((file as any).path && (window as any).electronAPI?.getFileThumbnail) {
        try {
          thumbnail = await (window as any).electronAPI.getFileThumbnail((file as any).path);
        } catch (e) {
          console.error('Failed to get thumbnail for', file.name, e);
        }
      }
      return {
        id: Math.random().toString(36).substring(7),
        display: file.name,
        type: isImage ? 'image' : 'file',
        file: file,
        url: URL.createObjectURL(file),
        thumbnail
      };
    }));
    setAttachments(prev => [...prev, ...newAttachments]);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    await processFiles(files);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    await processFiles(files);
    setIsAttachMenuOpen(false);
    e.target.value = '';
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
    setIsAttachMenuOpen(false);
  };

  const confirmRemoveAttachment = (id: string) => {
    const att = attachmentsRef.current.find(a => a.id === id);
    setAttachments(prev => prev.filter(a => a.id !== id));
    
    if (att && cmRef.current?.view) {
      const view = cmRef.current.view;
      const text = view.state.doc.toString();
      const escapedDisplay = att.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`@${escapedDisplay}\\b`, 'g');
      const changes = [];
      let match;
      while ((match = regex.exec(text))) {
        changes.push({ from: match.index, to: match.index + match[0].length, insert: '' });
      }
      if (changes.length > 0) {
        view.dispatch({ changes });
      }
    }
    setAttachmentToRemove(null);
  };

  const removeAttachment = (id: string) => {
    const att = attachmentsRef.current.find(a => a.id === id);
    if (!att) return;
    const text = value;
    const hasMentions = text.includes(`@${att.display}`);
    if (hasMentions) {
      setAttachmentToRemove(id);
    } else {
      confirmRemoveAttachment(id);
    }
  };

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (attachmentToRemove) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setAttachmentToRemove(null);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          confirmRemoveAttachment(attachmentToRemove);
        }
      }
    };
    if (attachmentToRemove) {
      window.addEventListener('keydown', handleGlobalKeyDown);
      return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }
  }, [attachmentToRemove]);

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

  return (
    <div 
      className="relative w-full rounded-[28px] mac-element transition-all focus-within:ring-2 focus-within:ring-white/20 p-4 flex flex-col gap-3 shadow-lg"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      
      {/* Removal Confirmation Prompt */}
      {attachmentToRemove && (
        <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setAttachmentToRemove(null)}>
          <div className="mac-element rounded-2xl p-6 max-w-sm w-full flex flex-col gap-4 shadow-2xl border border-white/10" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-medium text-lg">Remove Attachment?</h3>
            <p className="text-gray-300 text-sm">
              This attachment is currently referenced in your message. Removing it will also remove all mentions. Are you sure?
            </p>
            <div className="flex justify-end gap-3 mt-2">
              <button 
                onClick={() => setAttachmentToRemove(null)}
                className="px-4 py-2 rounded-xl text-sm font-medium text-gray-300 hover:bg-white/10 transition-colors"
              >
                Cancel (Esc)
              </button>
              <button 
                onClick={() => confirmRemoveAttachment(attachmentToRemove)}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
              >
                Remove (Enter)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-black/60 rounded-[28px] backdrop-blur-sm flex items-center justify-center p-3 pointer-events-none">
          <div className="w-full h-full border-2 border-dashed border-blue-400/50 rounded-[20px] bg-blue-500/10 flex flex-col items-center justify-center p-4">
            <div className="flex flex-col items-center gap-1 w-full px-2">
              <div className="text-white font-medium text-lg text-center w-full">Drop anything here</div>
              <div className="text-gray-400 text-xs text-center w-full break-words">
                Images, Documents, Spreadsheets, Presentations, Folders
              </div>
            </div>
            <div className="flex items-center gap-4 mt-4">
              <ImageIcon size={24} className="text-blue-400" />
              <FileText size={24} className="text-blue-400" />
              <FileSpreadsheet size={24} className="text-blue-400" />
              <MonitorPlay size={24} className="text-blue-400" />
              <Folder size={24} className="text-blue-400" />
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewAttachment && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-8 backdrop-blur-sm" onClick={() => setPreviewAttachment(null)}>
          <div className="relative w-full h-full max-w-5xl bg-[#1e1e1e] rounded-2xl overflow-hidden shadow-2xl border border-white/10 flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-white/10 bg-black/40">
              <div className="flex items-center gap-3 text-white">
                {getFileIcon(previewAttachment.type)}
                <span className="font-medium">{previewAttachment.display}</span>
              </div>
              <button onClick={() => setPreviewAttachment(null)} className="p-2 hover:bg-white/10 rounded-full transition-colors text-white">
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-hidden flex items-center justify-center bg-black/20">
              {previewAttachment.type === 'image' ? (
                <img src={previewAttachment.url} alt={previewAttachment.display} className="max-w-full max-h-full object-contain" />
              ) : (
                <iframe src={previewAttachment.url} className="w-full h-full bg-white" title="Preview" />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Attachments Preview Row */}
      {attachments.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            {attachments.map(att => (
              <div key={att.id} className="relative group flex flex-col items-center gap-1.5 w-16">
                <div className="relative w-14 h-14 rounded-[20px] mac-element flex items-center justify-center bg-black/20 overflow-hidden">
                  {att.type === 'image' && att.url ? (
                    <img src={att.url} alt={att.display} className="w-full h-full object-cover" />
                  ) : att.thumbnail ? (
                    <img src={att.thumbnail} alt={att.display} className="w-10 h-10 object-contain" />
                  ) : (
                    getFileIcon(att.type)
                  )}
                  
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
                {att.thumbnail ? (
                  <img src={att.thumbnail} className="w-3.5 h-3.5 object-contain" />
                ) : (
                  getFileIconSmall(att.type)
                )}
                <span className="truncate">{att.display}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* CodeMirror Input Area */}
      <div className="w-full min-h-[44px] max-h-[240px] overflow-y-auto px-2 py-1 relative z-10 flex flex-col justify-center">
        <CodeMirror
          ref={cmRef}
          value={value}
          theme="dark"
          placeholder="Message..."
          extensions={[
            markdown(),
            editorTheme,
            customKeymap,
            EditorView.lineWrapping,
            createMentionPlugin(() => attachmentsRef.current)
          ]}
          onUpdate={handleUpdate}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            bracketMatching: true,
            syntaxHighlighting: true,
            defaultKeymap: false,
            searchKeymap: false,
            historyKeymap: false,
            lintKeymap: false,
            completionKeymap: false,
            crosshairCursor: false,
            autocompletion: false,
          }}
          className="w-full h-full !outline-none"
        />
      </div>
      
      {/* Bottom Toolbar Row */}
      <div className="flex items-center justify-between mt-1 px-1">
        
        {/* Left Actions: Attach & Model Selector */}
        <div className="flex items-center gap-3 relative">
          
          {/* Attach Button Drop-up */}
          <div className="relative">
            <input 
              type="file" 
              multiple 
              className="hidden" 
              ref={fileInputRef}
              onChange={handleFileChange}
            />
            {isAttachMenuOpen && (
              <div className="absolute bottom-full left-0 mb-3 w-40 mac-element rounded-[24px] p-2 z-50 flex flex-col shadow-2xl">
                <button onClick={handleAttachClick} className="flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-2xl text-sm text-gray-300 hover:bg-white/10 hover:text-white transition-colors">
                  <FileText size={18} className="text-gray-400" />
                  Attach Files
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
                
                <div className="text-xs font-semibold text-gray-500 px-3 pt-3 pb-2 uppercase tracking-wider">Models</div>
                {isLoadingModels ? (
                  <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
                ) : allModels.length > 0 ? (
                  allModels.map((model) => (
                    <ModelItem 
                      key={`all-${model.id}`} 
                      model={model} 
                      isSelected={selectedModel?.id === model.id} 
                      onClick={() => { setSelectedModel(model); setIsModelMenuOpen(false); }} 
                    />
                  ))
                ) : (
                  <div className="px-3 py-2 text-sm text-gray-400">No models found</div>
                )}
              </div>
            )}
            
            <button 
              onClick={() => setIsModelMenuOpen(!isModelMenuOpen)}
              className="flex items-center gap-2.5 px-3.5 py-2 rounded-2xl mac-element mac-element-hover text-gray-200 font-medium text-sm transition-all"
            >
              {selectedModel ? (
                <>
                  <img 
                    src={PROVIDER_ICONS[selectedModel.provider] || PROVIDER_ICONS['ollama']} 
                    alt={selectedModel.provider} 
                    className="w-4 h-4 rounded-sm object-contain" 
                    onError={(e) => e.currentTarget.style.display = 'none'} 
                  />
                  <span className="truncate max-w-[150px]">{selectedModel.name}</span>
                </>
              ) : (
                <>
                  {isLoadingModels ? (
                    <div className="w-4 h-4 rounded-full bg-white/20 animate-pulse" />
                  ) : (
                    <AlertTriangle size={16} className="text-yellow-500" />
                  )}
                  <span className="truncate max-w-[150px]">{isLoadingModels ? 'Loading...' : 'No Models Found'}</span>
                </>
              )}
              <ChevronUp size={16} className={`transition-transform ml-1 ${isModelMenuOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>

        </div>

        {/* Right Action: Send/Stop Button */}
        {disabled && onStop ? (
          <button 
            onClick={onStop}
            className="p-2 bg-white text-black rounded-full hover:bg-gray-200 transition-colors" 
            title="Stop generating"
          >
            <Square fill="currentColor" size={20} strokeWidth={3} />
          </button>
        ) : (
          <button 
            onClick={handleSend}
            disabled={!selectedModel || (!value.trim() && attachments.length === 0)}
            className="p-2 bg-white text-black rounded-full hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:bg-white/20 disabled:text-white/40" 
            title="Send message"
          >
            <ArrowUp size={20} strokeWidth={3} />
          </button>
        )}
        
      </div>
    </div>
  );
};

export default ChatInput;
