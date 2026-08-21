import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { ArrowUp, ChevronUp, ChevronRight, Plus, FileText, Image as ImageIcon, Folder, X, FileSpreadsheet, MonitorPlay, AlertTriangle, Square, Check, RefreshCw, Settings2 } from 'lucide-react';
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

import { LLMModel, fetchModels, ModelSettings, getModelSettings, saveModelSettings } from '../utils/llm';
import DEFAULT_SYSTEM_PROMPT from '../utils/systemPrompt.md?raw';

const ModelItem = ({ model, isSelected, onClick }: { model: any, isSelected: boolean, onClick: () => void }) => (
  <button
    onClick={onClick}
    className={`menu-item ${isSelected
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
  disabled: boolean;
  editingBlock?: { id: string, type: 'user' | 'thinking' | 'response' } | null;
  onSaveEdit?: (id: string, type: 'user' | 'thinking' | 'response', text: string, attachments: any[]) => void;
  onCancelEdit?: () => void;
  onModelChange?: (model: LLMModel | null) => void;
  onEditPreview?: (text: string, attachments: any[]) => void;
  messages?: any[];
  children?: React.ReactNode;
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
    span.className = 'inline-flex items-center gap-1.5 bg-white/10 border border-white/5 text-accentBright px-2 h-[24px] rounded-md mx-1 align-middle select-none shadow-sm cursor-pointer hover:underline -my-2';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'flex items-center text-current';
    iconSpan.style.width = '14px';
    iconSpan.style.height = '14px';
    if (this.attachment?.thumbnail && this.attachment?.type === 'image') {
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
        if (this.attachment.path) {
          (window as any).electronAPI.openPath(this.attachment.path);
        } else if (this.attachment.url && this.attachment.url.startsWith('http')) {
          if ((window as any).require) {
            const { shell } = (window as any).require('electron');
            shell.openExternal(this.attachment.url);
          } else {
            window.open(this.attachment.url, '_blank');
          }
        }
      };
    }
    return span;
  }
}

export function createMentionPlugin(getAttachments: () => any[]) {
  const mentionDecoration = (match: RegExpExecArray, attachments: any[]) => {
    const text = match[0];
    const filename = match[1]; // match[1] has the captured name
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

      const attachmentNames = attachments.map(a => a.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const namesRegex = attachmentNames.join('|');
      const regex = new RegExp(`@(${namesRegex})`, 'g');

      for (let { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
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

const ChatInput: React.FC<ChatInputProps> = ({ onSend, onStop, disabled, editingBlock, onSaveEdit, onCancelEdit, onModelChange, onEditPreview, messages, children }) => {
  const [value, setValue] = useState('');
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [allModels, setAllModels] = useState<LLMModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<LLMModel | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);

  const [isAttachMenuOpen, setIsAttachMenuOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [modelSettings, setModelSettings] = useState<ModelSettings>(() => getModelSettings());
  const [estimatedTokens, setEstimatedTokens] = useState<{ total: number; prompt: number; history: number; system: number } | null>(null);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [attachmentToRemove, setAttachmentToRemove] = useState<string | null>(null);

  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [hasUnsentChanges, setHasUnsentChanges] = useState(false);

  const updateSettings = (partial: Partial<ModelSettings>) => {
    const updated = { ...modelSettings, ...partial };
    setModelSettings(updated);
    saveModelSettings(updated);
  };

  useEffect(() => {
    //only calculate tokens when settings panel is open
    if (!isSettingsOpen) return;

    const systemTokens = Math.ceil(DEFAULT_SYSTEM_PROMPT.length / 3.8);

    let historyChars = 0;
    if (messages) {
      for (const m of messages) {
        if (typeof m.content === 'string') {
          historyChars += m.content.length;
        }
        if (m.thinking) {
          historyChars += m.thinking.length;
        }
      }
    }
    const historyTokens = Math.ceil(historyChars / 3.8);

    let promptChars = value.length;
    for (const a of attachments) {
      if (a.rawContent) {
        promptChars += a.rawContent.length;
      } else if (a.display) {
        promptChars += a.display.length + 50;
      }
    }
    const promptTokens = Math.ceil(promptChars / 3.8);

    setEstimatedTokens({
      system: systemTokens,
      history: historyTokens,
      prompt: promptTokens,
      total: systemTokens + historyTokens + promptTokens,
    });
  }, [isSettingsOpen, messages, value, attachments]);

  const contextLimit = modelSettings.contextWindow || 8192;
  const usageSegments = [
    { key: 'prompt', label: 'Prompt', tokens: estimatedTokens?.prompt ?? 0, color: 'color-mix(in srgb, rgb(var(--accent-rgb)) 45%, white)' },
    { key: 'history', label: 'History', tokens: estimatedTokens?.history ?? 0, color: 'color-mix(in srgb, rgb(var(--accent-rgb)) 70%, white)' },
    { key: 'system', label: 'System', tokens: estimatedTokens?.system ?? 0, color: 'rgb(var(--accent-rgb))' },
  ];
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    if (scrollContainerRef.current) {
      const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
      setCanScrollRight(scrollWidth > clientWidth && scrollLeft < scrollWidth - clientWidth - 1);
    }
  }, []);

  useEffect(() => {
    checkScroll();
    window.addEventListener('resize', checkScroll);
    return () => window.removeEventListener('resize', checkScroll);
  }, [checkScroll, children]);

  const scrollToRight = () => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ left: scrollContainerRef.current.scrollWidth, behavior: 'smooth' });
    }
  };

  useEffect(() => {
    if (editingBlock && messages) {
      const msg = messages.find((m: any) => m.id === editingBlock.id);
      if (msg) {
        if (editingBlock.type === 'user' || editingBlock.type === 'response') {
          attachmentsRef.current = msg.attachments || [];
          setValue(msg.content || '');
          setAttachments(msg.attachments || []);
        } else if (editingBlock.type === 'thinking') {
          attachmentsRef.current = [];
          setValue(msg.thinking || '');
          setAttachments([]);
        }
      }
    }
  }, [editingBlock]);
  
  const getAllAttachments = useCallback(() => {
    const messageAttachments = messages ? messages.flatMap((m: any) => m.attachments || []) : [];
    const all = [...messageAttachments, ...attachments];
    
    // Deduplicate by display name
    const unique: any[] = [];
    const seen = new Set();
    for (const a of all) {
      if (!seen.has(a.display)) {
        seen.add(a.display);
        unique.push(a);
      }
    }
    return unique;
  }, [messages, attachments]);

  const allAttachmentsRef = useRef<any[]>([]);
  useEffect(() => {
    allAttachmentsRef.current = getAllAttachments();
  }, [getAllAttachments]);
  
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

  useEffect(() => {
    if (onModelChange) {
      onModelChange(selectedModel);
    }
  }, [selectedModel, onModelChange]);

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

  // Mentions State
  const [isMentionMenuOpen, setIsMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionRange, setMentionRange] = useState<{ from: number, to: number } | null>(null);
  const [focusedMentionIndex, setFocusedMentionIndex] = useState(0);

  useEffect(() => {
    setFocusedMentionIndex(0);
  }, [mentionQuery, isMentionMenuOpen]);

  const filteredAttachments = getAllAttachments().filter(a => a.display.toLowerCase().includes(mentionQuery));

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

  const handleSend = () => {
    if ((!value.trim() && attachments.length === 0) || !selectedModel || disabled) return;
    
    if (editingBlock && onSaveEdit) {
      onSaveEdit(editingBlock.id, editingBlock.type, value, attachments);
      setValue('');
      setAttachments([]);
      if (onCancelEdit) onCancelEdit();
    } else {
      onSend(value, attachments, selectedModel);
      setValue('');
      setAttachments([]);
    }
  };

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

  const handleUpdate = useCallback((viewUpdate: ViewUpdate) => {
    if (viewUpdate.docChanged) {
      const newVal = viewUpdate.state.doc.toString();
      setValue(newVal);
      setHasUnsentChanges(true);
      if (editingBlock && onEditPreview) {
        onEditPreview(newVal, attachmentsRef.current);
      }
    }
    const state = viewUpdate.state;
    const selection = state.selection.main;
    if (selection.empty) {
      const pos = selection.head;
      const line = state.doc.lineAt(pos);
      const textBefore = line.text.slice(0, pos - line.from);
      const match = textBefore.match(/(?:^|\s)@([^@]{0,50})$/);
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
  }, [editingBlock, onEditPreview]);

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
      const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|ogg|mov)$/i.test(file.name);
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
      
      let filePath = '';
      if ((window as any).electronAPI?.getPathForFile) {
        filePath = (window as any).electronAPI.getPathForFile(file);
      } else {
        filePath = (file as any).path || '';
      }

      let thumbnail = null;
      const objectUrl = URL.createObjectURL(file);
      
      if (isPdf) {
        try {
          const pdfjsLib = await import('pdfjs-dist');
          pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;
          
          const loadingTask = pdfjsLib.getDocument({ url: objectUrl });
          const pdfDocument = await loadingTask.promise;
          const page = await pdfDocument.getPage(1);
          
          const viewport = page.getViewport({ scale: 1.0 });
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          
          if (context) {
            // target max 256px dimension
            const scale = Math.min(256 / viewport.width, 256 / viewport.height, 1);
            const scaledViewport = page.getViewport({ scale });
            canvas.width = scaledViewport.width;
            canvas.height = scaledViewport.height;
            
            await page.render({ canvasContext: context, viewport: scaledViewport } as any).promise;
            thumbnail = canvas.toDataURL('image/jpeg', 0.8);
          }
        } catch (e) {
          console.error('Failed to generate PDF thumbnail', e);
        }
      } else if (isVideo) {
        try {
          thumbnail = await new Promise((resolve) => {
            const video = document.createElement('video');
            video.src = objectUrl;
            video.crossOrigin = 'anonymous';
            video.currentTime = 1.0; // Seek to 1 second
            
            video.onloadeddata = () => {
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              if (ctx) {
                const scale = Math.min(256 / video.videoWidth, 256 / video.videoHeight, 1);
                canvas.width = video.videoWidth * scale;
                canvas.height = video.videoHeight * scale;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', 0.8));
              } else {
                resolve(null);
              }
            };
            video.onerror = () => resolve(null);
          });
        } catch (e) {
          console.error('Failed to generate Video thumbnail', e);
        }
      }
      
      // Fallback to electron getFileThumbnail for others
      if (!thumbnail && !isImage && filePath && (window as any).electronAPI?.getFileThumbnail) {
        try {
          thumbnail = await (window as any).electronAPI.getFileThumbnail(filePath);
        } catch (e) {
          console.error('Failed to get thumbnail for', file.name, e);
        }
      }
      
      return {
        id: Math.random().toString(36).substring(7),
        display: file.name,
        type: isImage ? 'image' : isVideo ? 'video' : 'file',
        file: file,
        path: filePath,
        url: objectUrl,
        thumbnail
      };
    }));
    const updated = [...attachments, ...newAttachments];
    setAttachments(updated);
    if (editingBlock && onEditPreview) {
      onEditPreview(value, updated);
    }
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
      case 'image': return <ImageIcon size={24} className="text-gray-400" />;
      case 'folder': return <Folder size={24} className="text-gray-400" />;
      default: return <FileText size={24} className="text-gray-400" />;
    }
  };

  const getFileIconSmall = (type: string) => {
    switch (type) {
      case 'image': return <ImageIcon size={14} className="text-gray-400" />;
      case 'folder': return <Folder size={14} className="text-gray-400" />;
      default: return <FileText size={14} className="text-gray-400" />;
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
                className="px-4 py-2 rounded-xl text-sm font-medium bg-white/10 text-gray-300 hover:bg-white/20 hover:text-white transition-colors"
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
          <div className="w-full h-full border-2 border-dashed border-accentBright/50 rounded-[20px] bg-accent/10 flex flex-col items-center justify-center p-4">
            <div className="flex flex-col items-center gap-1 w-full px-2">
              <div className="text-white font-medium text-lg text-center w-full">Drop anything here</div>
              <div className="text-gray-400 text-xs text-center w-full break-words">
                Images, Documents, Spreadsheets, Presentations, Folders
              </div>
            </div>
            <div className="flex items-center gap-4 mt-4">
              <ImageIcon size={24} className="text-accentBright" />
              <FileText size={24} className="text-accentBright" />
              <FileSpreadsheet size={24} className="text-accentBright" />
              <MonitorPlay size={24} className="text-accentBright" />
              <Folder size={24} className="text-accentBright" />
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
                    onClick={() => {
                      const newAtts = attachments.filter(a => a.id !== att.id);
                      setAttachments(newAtts);
                      if (editingBlock && onEditPreview) {
                        onEditPreview(value, newAtts);
                      }
                    }}
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
                className={`flex items-center gap-3 w-full text-left px-3 py-2.5 rounded-2xl text-sm transition-colors ${i === focusedMentionIndex ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/10 hover:text-white'
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
      <div className="w-full min-h-[44px] max-h-[240px] overflow-y-auto px-2 py-1 relative z-10">
        <CodeMirror
          ref={cmRef}
          value={value}
          theme="dark"
          placeholder="Ask anything, @ to mention"
          extensions={[
            markdown(),
            editorTheme,
            customKeymap,
            EditorView.lineWrapping,
            useMemo(() => createMentionPlugin(() => allAttachmentsRef.current), [])
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
      <div className="flex items-center justify-between mt-1 px-1 gap-2 w-full">

        {/* Left Actions: Attach & Model Selector */}
        <div className="flex items-center gap-3 shrink-0 relative z-20">

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
              <div className="absolute bottom-full left-0 mb-3 w-40 menu-panel rounded-[24px] p-2 z-50 flex flex-col">
                <button onClick={handleAttachClick} className="menu-item">
                  <FileText size={18} className="text-gray-400" />
                  Attach Files
                </button>
              </div>
            )}
            <button
              onClick={() => {
                setIsAttachMenuOpen(!isAttachMenuOpen);
                setIsSettingsOpen(false);
                setIsModelMenuOpen(false);
              }}
              className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-white/10 transition-all"
              title="Attach file"
            >
              <Plus size={20} className={`transition-transform duration-200 ${isAttachMenuOpen ? 'rotate-45' : ''}`} />
            </button>
          </div>

          {/* Settings-2 Model Adjustments Drop-up */}
          <div className="relative">
            {isSettingsOpen && (
              <div className="absolute bottom-full left-0 mb-3 w-80 menu-panel rounded-[24px] p-4 z-50 flex flex-col gap-3.5 text-gray-200">
                {/* Header + Context Usage Chart */}
                <div className="flex flex-col gap-2">
                  <span className="menu-header">Model Parameters</span>
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold text-white font-mono">
                      {estimatedTokens?.total.toLocaleString() || '0'}
                    </span>
                    <span className="text-xs text-gray-500 font-mono">
                      of {contextLimit.toLocaleString()} tokens
                    </span>
                  </div>
                  <div className="flex h-2 w-full rounded-full overflow-hidden bg-white/10">
                    {usageSegments.map((seg) => (
                      <div
                        key={seg.key}
                        className="h-full"
                        style={{ width: `${(seg.tokens / contextLimit) * 100}%`, backgroundColor: seg.color }}
                      />
                    ))}
                  </div>
                  <div className="flex items-center justify-between text-xs text-gray-400 px-0.5">
                    {usageSegments.map((seg) => (
                      <span key={seg.key} className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: seg.color }} />
                        {seg.label} {Math.round((seg.tokens / contextLimit) * 100)}%
                      </span>
                    ))}
                  </div>
                </div>

                {/* Thinking Level */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-300 font-medium">Thinking Level</span>
                    <span className="text-gray-400 font-mono text-xs capitalize">{modelSettings.thinkingLevel}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-1 p-1 bg-black/30 rounded-xl border border-white/5">
                    {(['off', 'low', 'medium', 'high'] as const).map(level => (
                      <button
                        key={level}
                        type="button"
                        onClick={() => updateSettings({ thinkingLevel: level })}
                        className={`py-1.5 text-sm rounded-lg capitalize transition-colors ${
                          modelSettings.thinkingLevel === level
                            ? 'bg-white/20 text-white font-medium shadow-sm'
                            : 'text-gray-400 hover:text-gray-200'
                        }`}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Thinking Timeout */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-300 font-medium">Thinking Timeout</span>
                    <span className="text-gray-400 font-mono text-xs">
                      {modelSettings.thinkingTimeout === 0 ? 'No timeout' : `${modelSettings.thinkingTimeout}s`}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={300}
                    step={10}
                    value={modelSettings.thinkingTimeout}
                    onChange={(e) => updateSettings({ thinkingTimeout: Number(e.target.value) })}
                    className="neutral-slider w-full cursor-pointer"
                    style={{ '--fill': `${(modelSettings.thinkingTimeout / 300) * 100}%` } as React.CSSProperties}
                  />
                </div>

                {/* Model Temperature */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-300 font-medium">Model Temperature</span>
                    <span className="text-gray-400 font-mono text-xs">{modelSettings.temperature.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={modelSettings.temperature}
                    onChange={(e) => updateSettings({ temperature: Number(e.target.value) })}
                    className="neutral-slider w-full cursor-pointer"
                    style={{ '--fill': `${(modelSettings.temperature / 2) * 100}%` } as React.CSSProperties}
                  />
                </div>

                {/* Top-P */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-300 font-medium">Top-P</span>
                    <span className="text-gray-400 font-mono text-xs">{modelSettings.topP.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={modelSettings.topP}
                    onChange={(e) => updateSettings({ topP: Number(e.target.value) })}
                    className="neutral-slider w-full cursor-pointer"
                    style={{ '--fill': `${modelSettings.topP * 100}%` } as React.CSSProperties}
                  />
                </div>

                {/* Max Output Length */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-300 font-medium">Max Output Length</span>
                    <span className="text-gray-400 font-mono text-xs">
                      {modelSettings.maxOutputLength ? `${modelSettings.maxOutputLength.toLocaleString()} tokens` : 'Default'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={256}
                    max={32768}
                    step={256}
                    value={modelSettings.maxOutputLength || 4096}
                    onChange={(e) => updateSettings({ maxOutputLength: Number(e.target.value) })}
                    className="neutral-slider w-full cursor-pointer"
                    style={{ '--fill': `${(((modelSettings.maxOutputLength || 4096) - 256) / (32768 - 256)) * 100}%` } as React.CSSProperties}
                  />
                </div>

                {/* Context Window */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-gray-300 font-medium">Context Window</span>
                    <span className="text-gray-400 font-mono text-xs">
                      {modelSettings.contextWindow >= 1024 ? `${Math.round(modelSettings.contextWindow / 1024)}K` : modelSettings.contextWindow} tokens
                    </span>
                  </div>
                  <input
                    type="range"
                    min={1024}
                    max={131072}
                    step={1024}
                    value={modelSettings.contextWindow || 8192}
                    onChange={(e) => updateSettings({ contextWindow: Number(e.target.value) })}
                    className="neutral-slider w-full cursor-pointer"
                    style={{ '--fill': `${(((modelSettings.contextWindow || 8192) - 1024) / (131072 - 1024)) * 100}%` } as React.CSSProperties}
                  />
                </div>
              </div>
            )}
            <button
              onClick={() => {
                const next = !isSettingsOpen;
                setIsSettingsOpen(next);
                if (next) {
                  setIsAttachMenuOpen(false);
                  setIsModelMenuOpen(false);
                }
              }}
              className="p-2 text-gray-400 hover:text-white rounded-full hover:bg-white/10 transition-all"
              title="Model settings"
            >
              <Settings2 size={20} className={`transition-colors ${isSettingsOpen ? 'text-white' : ''}`} />
            </button>
          </div>

          {/* Model Selector Drop-up */}
          <div className="relative">
            {isModelMenuOpen && (
              <div className="absolute bottom-full left-0 mb-3 w-64 menu-panel rounded-[24px] p-2 z-50 flex flex-col">

                <div className="flex items-center justify-between px-3 pt-3 pb-2">
                  <span className="menu-header">Models</span>
                  <button
                    onClick={loadModels}
                    disabled={isLoadingModels}
                    className="p-1 text-gray-500 hover:text-white rounded-md hover:bg-white/10 transition-colors disabled:opacity-50"
                    title="Refresh models"
                  >
                    <RefreshCw size={12} className={isLoadingModels ? 'animate-spin' : ''} />
                  </button>
                </div>
                {isLoadingModels ? (
                  <div className="px-3 py-2 text-sm text-gray-400">Loading...</div>
                ) : allModels.length > 0 ? (
                  allModels.map((model) => (
                    <ModelItem
                      key={`all-${model.id}`}
                      model={model}
                      isSelected={selectedModel?.id === model.id}
                      onClick={() => { 
                        setSelectedModel(model); 
                        setIsModelMenuOpen(false); 
                      }}
                    />
                  ))
                ) : (
                  <div className="px-3 py-2 text-sm text-gray-400">No models found</div>
                )}
              </div>
            )}

            <button
              onClick={() => {
                if (!disabled) {
                  setIsModelMenuOpen(!isModelMenuOpen);
                  setIsAttachMenuOpen(false);
                  setIsSettingsOpen(false);
                }
              }}
              disabled={disabled}
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
                    <AlertTriangle size={16} className="text-gray-400" />
                  )}
                  <span className="truncate max-w-[150px]">{isLoadingModels ? 'Loading...' : 'No Models Found'}</span>
                </>
              )}
              <ChevronUp size={16} className={`transition-transform ml-1 ${isModelMenuOpen ? 'rotate-180' : ''}`} />
            </button>
          </div>

          {editingBlock && (
            <div className="flex items-center gap-2.5 mr-auto px-3.5 py-2 rounded-2xl mac-element text-gray-200 font-medium text-sm transition-all border border-white/5">
              <span className="flex items-center gap-1.5">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                Editing
              </span>
              <button
                onClick={() => {
                  setValue('');
                  setAttachments([]);
                  if (onCancelEdit) onCancelEdit();
                }}
                className="text-gray-400 hover:text-white p-0.5 rounded-md hover:bg-white/10 ml-1"
              >
                <X size={14} />
              </button>
            </div>
          )}

        </div>

        {/* Scrollable Append Area */}
        {children && (
          <div className="flex-1 overflow-hidden relative flex items-center h-[36px] z-0">
            <div 
              ref={scrollContainerRef}
              onScroll={checkScroll}
              className="flex-1 h-full overflow-x-auto flex items-center gap-2 px-1 scroll-smooth" 
              style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            >
              <style>{`
                .no-scrollbar::-webkit-scrollbar {
                  display: none;
                }
              `}</style>
              <div className="flex items-center gap-2 flex-nowrap w-max no-scrollbar h-full">
                {children}
              </div>
            </div>
            {canScrollRight && (
              <>
                <div className="absolute right-0 top-0 bottom-0 w-8 bg-gradient-to-l from-surface to-transparent pointer-events-none" />
                <button
                  onClick={scrollToRight}
                  className="absolute right-0 top-1/2 -translate-y-1/2 bg-white/10 hover:bg-white/20 text-white p-1 rounded-full shadow-md z-10 transition-colors"
                >
                  <ChevronRight size={14} />
                </button>
              </>
            )}
          </div>
        )}
        
        {!children && <div className="flex-1" />}

        {/* Right Action: Send/Stop Button */}
        <div className="shrink-0 flex items-center">
          {disabled && onStop && !editingBlock ? (
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
              className={`p-2 rounded-full transition-colors bg-white text-black hover:bg-gray-200 disabled:opacity-50 disabled:bg-white/20 disabled:text-white/40 shadow-lg`}
              title={editingBlock ? "Save edit" : "Send message"}
            >
              {editingBlock ? (
                <Check size={20} strokeWidth={3} />
              ) : (
                <ArrowUp size={20} strokeWidth={3} />
              )}
            </button>
          )}
        </div>

      </div>
    </div>
  );
};

export default ChatInput;
