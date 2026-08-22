import React, { useState, useRef, useEffect } from 'react';
import ChatInput from './ChatInput';
import ThinkingBlock from './ThinkingBlock';
import ToolCallBlock from './ToolCallBlock';
import AgentBrowser from './AgentBrowser';
import { generateChatStream, LLMModel, fileToBase64, parseAttachmentDocument } from '../utils/llm';
import { executeToolCalls, ToolContext } from '../utils/toolExecutor';
import { spawnSubAgent, getAgentsSnapshot, waitForAgents } from '../utils/subAgents';
import DEFAULT_SYSTEM_PROMPT from '../utils/systemPrompt.md?raw';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { MessageSquarePlus, MessageSquare, X, Check, Globe, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { getSystemTools } from '../utils/tools';
import { agentBrowserStore } from '../utils/agentBrowserStore';
import { terminateBrowserSession } from '../utils/browserTools';
import ApprovalCard, { PendingApproval } from './ApprovalCard';

const MarkdownComponents: any = {
  p: ({node, ...props}: any) => <p className="mb-2 last:mb-0" {...props} />,
  h1: ({node, ...props}: any) => <h1 className="text-2xl font-bold mb-4 mt-6" {...props} />,
  h2: ({node, ...props}: any) => <h2 className="text-xl font-bold mb-3 mt-5" {...props} />,
  h3: ({node, ...props}: any) => <h3 className="text-lg font-bold mb-2 mt-4" {...props} />,
  ul: ({node, ...props}: any) => <ul className="list-disc pl-6 mb-4 space-y-1" {...props} />,
  ol: ({node, ...props}: any) => <ol className="list-decimal pl-6 mb-4 space-y-1" {...props} />,
  li: ({node, ...props}: any) => <li className="leading-relaxed" {...props} />,
  a: ({node, ...props}: any) => <a className="text-accentBright hover:underline" target="_blank" rel="noopener noreferrer" {...props} />,
  strong: ({node, ...props}: any) => <strong className="font-bold text-gray-100" {...props} />,
  blockquote: ({node, ...props}: any) => <blockquote className="border-l-4 border-gray-500 pl-4 py-1 italic text-textSecondary my-4" {...props} />,
  code: ({node, inline, className, children, ...props}: any) => {
    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <div className="rounded-lg overflow-hidden my-4 border border-white/10 bg-overlay">
        <div className="bg-black/40 px-4 py-1 text-xs text-textSecondary flex items-center justify-between border-b border-white/10">
          <span>{match[1]}</span>
        </div>
        <SyntaxHighlighter
          {...props}
          children={String(children).replace(/\n$/, '')}
          style={vscDarkPlus}
          language={match[1]}
          PreTag="div"
          customStyle={{ margin: 0, background: 'transparent', padding: '1rem', fontSize: '0.875rem' }}
        />
      </div>
    ) : (
      <code {...props} className="bg-white/10 px-1.5 py-0.5 rounded text-sm font-mono text-textSecondary">
        {children}
      </code>
    );
  }
};

export interface ChatComment {
  id: string;
  quote: string;
  text: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  status: 'executing' | 'completed' | 'error';
  result?: string;
  raw?: string;
  image?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  // Per-round thinking chunks: parts[i] precedes tool-call round i+1.
  thinkingParts?: string[];
  attachments?: any[];
  isGenerating?: boolean;
  comments?: ChatComment[];
  toolCalls?: ToolCall[];
  isCallingTool?: boolean;
}

// Safety cap so a model stuck in tool-call loops can't run forever
const MAX_TOOL_ROUNDS = 10;

const truncateForContext = (s: string, max = 6000) =>
  s.length > max ? s.slice(0, max) + `\n...[truncated ${s.length - max} chars]` : s;

const BlockToolbar = ({ onEdit, onRegenerate, onDelete }: { onEdit?: () => void, onRegenerate?: () => void, onDelete?: () => void }) => {
  return (
    <div className="absolute -top-[38px] right-0 pb-1.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-20">
      <div className="flex items-center gap-1 mac-element p-1 rounded-full border border-white/5 shadow-sm">
        {onEdit && (
          <button onClick={onEdit} className="p-1.5 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors" title="Edit">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
          </button>
        )}
        {onRegenerate && (
          <button onClick={onRegenerate} className="p-1.5 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors" title="Regenerate">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
          </button>
        )}
        {onDelete && (
          <button onClick={onDelete} className="p-1.5 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors" title="Delete">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
          </button>
        )}
      </div>
    </div>
  );
};

const ChatArea = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  
  // Edit mode tracking
  const [editingBlock, setEditingBlock] = useState<{ id: string, type: 'user' | 'thinking' | 'response' } | null>(null);
  const [editPreview, setEditPreview] = useState<{ text: string, attachments: any[] } | null>(null);
  
  const [currentModel, setCurrentModel] = useState<LLMModel | null>(null);
  const [lastUsedModel, setLastUsedModel] = useState<LLMModel | null>(null);
  
  // Selection state
  const [selectionContext, setSelectionContext] = useState<{ text: string, x: number, y: number, msgId: string, msgType: 'user' | 'thinking' | 'response' } | null>(null);
  const [commentInputContext, setCommentInputContext] = useState<{ text: string, msgId: string, msgType: 'user' | 'thinking' | 'response' } | null>(null);
  const [commentInputValue, setCommentInputValue] = useState('');
  const [activeComment, setActiveComment] = useState<{ commentId: string, msgId: string, msgType: 'user' | 'thinking' | 'response', quote: string, x: number, y: number } | null>(null);
  const [isCommentPinned, setIsCommentPinned] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [isBrowserExpanded, setIsBrowserExpanded] = useState(false);
  const commentPopupHoverRef = useRef(false);
  const isCommentPinnedRef = useRef(false);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);
  
  const autoScrollEnabled = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Permission-gated tool approvals (self-modification, shell, deletion, desktop input)
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  // The model the agent loop should use — switchable mid-conversation by the agent itself.
  const activeModelRef = useRef<LLMModel | null>(null);
  useEffect(() => {
    activeModelRef.current = currentModel || lastUsedModel;
  }, [currentModel, lastUsedModel]);

  const requestApproval = (toolName: string, summary: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const id = Math.random().toString(36).substring(7);
      setPendingApprovals(prev => [...prev, {
        id,
        toolName,
        summary,
        onDecision: (approved: boolean) => {
          setPendingApprovals(prev2 => prev2.filter(p => p.id !== id));
          resolve(approved);
        }
      }]);
    });

  const flushPendingApprovals = (approved: boolean) => {
    setPendingApprovals(prev => {
      prev.forEach(p => p.onDecision(approved));
      return [];
    });
  };

  const switchActiveModel = (model: LLMModel) => {
    activeModelRef.current = model;
    setCurrentModel(model);
    window.dispatchEvent(new CustomEvent('agent-model-changed', { detail: model }));
  };

  const createToolContext = (): ToolContext => ({
    getModel: () => activeModelRef.current || lastUsedModel,
    setModel: switchActiveModel,
    requestApproval,
    spawnAgent: (spec) => spawnSubAgent(spec, {
      requestApproval,
      getModel: () => activeModelRef.current || lastUsedModel,
      signal: abortControllerRef.current?.signal
    }),
    getAgents: getAgentsSnapshot,
    waitForAgents,
    signal: abortControllerRef.current?.signal
  });

  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    // Tighter tolerance (30px) so deviating slightly detaches the lock smoothly
    const isNearBottom = scrollHeight - scrollTop - clientHeight <= 30;
    autoScrollEnabled.current = isNearBottom;
  };

  useEffect(() => {
    isCommentPinnedRef.current = isCommentPinned;
    if (isCommentPinned) {
      commentTextareaRef.current?.focus();
    }
  }, [isCommentPinned]);

  const showCommentPopup = (el: Element, pinned: boolean) => {
    const commentId = el.getAttribute('data-comment-id');
    const encodedQuote = el.getAttribute('data-encoded-quote');
    const encodedText = el.getAttribute('data-encoded-text');
    const messageBlock = el.closest('[data-msg-id]');
    if (!commentId || !encodedQuote || !encodedText || !messageBlock) return;
    const msgId = messageBlock.getAttribute('data-msg-id') as string;
    const msgType = messageBlock.getAttribute('data-msg-type') as 'user' | 'thinking' | 'response';
    const rect = el.getBoundingClientRect();
    const half = 152; // half of w-72 panel
    const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8);
    setActiveComment({
      commentId,
      msgId,
      msgType,
      quote: decodeURIComponent(atob(encodedQuote)),
      x,
      y: rect.top - 10,
    });
    setCommentDraft(decodeURIComponent(atob(encodedText)));
    setIsCommentPinned(pinned);
  };

  // Hover preview for existing comments (same UI as clicked; click pins it)
  useEffect(() => {
    const handleMouseOver = (e: MouseEvent) => {
      if (isCommentPinnedRef.current) return;
      const mark = (e.target as HTMLElement).closest('.comment-icon-btn');
      if (mark) showCommentPopup(mark, false);
    };
    const handleMouseOut = (e: MouseEvent) => {
      if (isCommentPinnedRef.current) return;
      const mark = (e.target as HTMLElement).closest('.comment-icon-btn');
      if (!mark) return;
      const commentId = mark.getAttribute('data-comment-id');
      setTimeout(() => {
        if (isCommentPinnedRef.current || commentPopupHoverRef.current) return;
        if ((mark as HTMLElement).matches(':hover')) return;
        setActiveComment(cur => (cur && cur.commentId === commentId ? null : cur));
      }, 80);
    };
    const handleScrollAway = () => {
      if (!isCommentPinnedRef.current) setActiveComment(null);
    };
    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mouseout', handleMouseOut);
    document.addEventListener('scroll', handleScrollAway, true);
    return () => {
      document.removeEventListener('mouseover', handleMouseOver);
      document.removeEventListener('mouseout', handleMouseOut);
      document.removeEventListener('scroll', handleScrollAway, true);
    };
  }, []);

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // Wait a tick to allow clicks on the button to process before clearing
      setTimeout(() => {
        if (commentInputContext) return;
        
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed) {
          setSelectionContext(null);
          return;
        }
        
        const text = selection.toString().trim();
        if (!text) {
          setSelectionContext(null);
          return;
        }

        const range = selection.getRangeAt(0);
        let container = range.commonAncestorContainer as HTMLElement;
        if (container.nodeType === 3) container = container.parentElement!;
        
        const messageBlock = container.closest('[data-msg-id]');
        if (!messageBlock) {
          setSelectionContext(null);
          return;
        }

        const msgId = messageBlock.getAttribute('data-msg-id') as string;
        const msgType = messageBlock.getAttribute('data-msg-type') as 'user' | 'thinking' | 'response';
        
        // Only allow comments on responses
        if (msgType !== 'response') {
          setSelectionContext(null);
          return;
        }
        
        const rect = range.getBoundingClientRect();
        
        setSelectionContext({
          text,
          x: rect.left + rect.width / 2,
          y: rect.top - 10,
          msgId,
          msgType
        });
      }, 10);
    };
    
    const handleMouseDown = (e: MouseEvent) => {
      // If clicking inside the comment input or the add comment button, don't clear
      const target = e.target as HTMLElement;
      
      // Handle click on comment icon — locks in the popup
      const mark = target.closest('.comment-icon-btn');
      if (mark) {
        showCommentPopup(mark, true);
        return;
      }

      if (target.closest('.comment-popup-ui')) return;
      if (window.getSelection()?.isCollapsed) {
        setSelectionContext(null);
        setCommentInputContext(null);
        setIsCommentPinned(false);
        setActiveComment(null);
      }
    };
    
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);
    
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [commentInputContext]);

  // Auto-scroll when messages change or generation updates
  useEffect(() => {
    if (autoScrollEnabled.current) {
      // Use behavior: 'auto' so it doesn't tween constantly on every token, causing jitter
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, isGenerating]);

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    flushPendingApprovals(false);
    setIsGenerating(false);
  };

  const allAttachments = messages.flatMap(m => m.attachments || []);

  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const formatMentions = (text: string, msgComments?: ChatComment[]) => {
    let processedText = text;
    if (msgComments && msgComments.length > 0) {
      msgComments.forEach(comment => {
        if (!comment.quote) return;
        // Escape the quote for regex safely
        const escapedQuote = comment.quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // We use a regex to replace only the first occurrence to avoid messing up duplicate phrases
        const quoteRegex = new RegExp(`(${escapedQuote})`);
        
        // Find the message this comment belongs to by looking at the ID of the comment (actually we don't have msgId here, but we can pass it)
        // Wait, formatMentions is called per message block, so we know the message block it's in.
        // We need the msgId and msgType to pass to openCommentEdit.
        // Actually, I didn't pass msgId or msgType to formatMentions. I should.
        // Let's just use data attributes and attach an event listener to the container, OR pass msgId and msgType to formatMentions.
        // Use a span with data attributes and we will render a tooltip using CSS or JS
        processedText = processedText.replace(quoteRegex, `<mark class="bg-accent/20 text-white rounded relative group/comment cursor-pointer comment-icon-btn" data-comment-id="${comment.id}" data-encoded-quote="${btoa(encodeURIComponent(comment.quote))}" data-encoded-text="${btoa(encodeURIComponent(comment.text))}">$1<span class="absolute -top-2 -right-2 z-20 flex"><span class="bg-accent text-white rounded-full p-1 shadow-md flex items-center justify-center hover:bg-accentHover transition-colors"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span></span></mark>`);
      });
    }

    if (!processedText) return processedText;
    if (allAttachments.length === 0) return processedText;
    
    const attachmentNames = allAttachments.map(a => a.display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const namesRegex = attachmentNames.join('|');
    
    // First, strip backticks around exactly a mention (e.g., `@IMG_0029.JPG`)
    const stripBackticksRegex = new RegExp(`\\\`@(${namesRegex})\\\``, 'g');
    processedText = processedText.replace(stripBackticksRegex, '@$1');

    // Match code blocks, inline code, or exact attachment names to strictly avoid replacing within code
    const regex = new RegExp(`(\`\`\`[\\s\\S]*?\`\`\`|\`[^\`]+\`)|(?<![a-zA-Z0-9])@(${namesRegex})`, 'g');
    
    return processedText.replace(regex, (match, codeBlock, mention) => {
      if (codeBlock) return codeBlock;
      if (mention) {
        return `<span data-mention="${mention}"></span>`;
      }
      return match;
    });
  };

  const getFileIcon = (type: string) => {
    if (type === 'image') {
      return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>;
    } else if (type === 'folder') {
      return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>;
    } else {
      return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>;
    }
  };

  const chatComponents = {
    ...MarkdownComponents,
    span: ({node, className, ...props}: any) => {
      const mentionFile = props['data-mention'];
      if (mentionFile) {
        let att = allAttachments.find(a => a.display === mentionFile);
        let icon = null;
        if (att?.thumbnail && att?.type === 'image') {
          icon = <img src={att.thumbnail} style={{width: 14, height: 14, objectFit: 'contain'}} />;
        } else {
          let type = att?.type || 'file';
          if (!att) {
            const ext = mentionFile.split('.').pop()?.toLowerCase();
            if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext || '')) type = 'image';
            else type = 'file';
          }
          icon = getFileIcon(type);
        }

        return (
          <span 
            className="mention inline-flex items-center gap-1.5 bg-white/10 border border-white/5 text-accentBright px-2 h-[24px] rounded-md mx-1 align-middle select-none cursor-pointer hover:underline"
            onClick={() => {
              if (att?.path) {
                (window as any).electronAPI.openPath(att.path);
              }
            }}
          >
            <span className="flex items-center text-current" style={{ width: 14, height: 14 }}>
              {icon}
            </span>
            <span className="text-[13px] font-medium leading-none">{mentionFile}</span>
          </span>
        );
      }
      return <span className={className} {...props} />;
    }
  };

  const handleSendMessage = async (text: string, attachments: any[], model: LLMModel) => {
    if (!text.trim() && attachments.length === 0) return;
    setLastUsedModel(model);

    // Build the user message
    const userMsg: ChatMessage = {
      id: Math.random().toString(36).substring(7),
      role: 'user',
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined
    };

    const newMsgs = [...messages, userMsg];
    setMessages(newMsgs);
    
    await triggerGeneration(newMsgs, model);
  };

  const triggerGeneration = async (contextMsgs: ChatMessage[], targetModel: LLMModel, keepThinking?: string, feedbackComments?: ChatComment[]) => {
    setIsGenerating(true);
    abortControllerRef.current = new AbortController();

    // Re-enable autoscroll when generation starts
    autoScrollEnabled.current = true;
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);

    const assistantMsgId = Math.random().toString(36).substring(7);

    // Add temporary loading message for assistant
    setMessages([...contextMsgs, { 
      id: assistantMsgId,
      role: 'assistant', 
      content: '', 
      thinking: keepThinking || '', 
      isGenerating: true 
    }]);

    try {
      // Format payload for OpenAI-compatible API
      const formattedMessages: any[] = [];
      
      // System prompt for multi-attachment focus weighting
      formattedMessages.push({
        role: 'system',
        content: DEFAULT_SYSTEM_PROMPT
      });

      for (const msg of contextMsgs) {
        let textContent = msg.content || '';

        // If this is a previous assistant turn with thinking, preserve it in the context!
        if (msg.role === 'assistant' && msg.thinking) {
          textContent = `<think>\n${msg.thinking}\n</think>\n\n${textContent}`;
        }
        
        // Append comments context
        if (msg.comments && msg.comments.length > 0) {
          textContent += `\n\n--- User Comments on this message ---\n`;
          msg.comments.forEach(c => {
            textContent += `On text: "${c.quote}"\nComment: "${c.text}"\n\n`;
          });
          textContent += `--- End User Comments ---`;
        }
        
        if (msg.attachments && msg.attachments.length > 0) {
          const content = [];
          
          for (const att of msg.attachments) {
            if (att.type === 'image' && att.file) {
              const b64 = await fileToBase64(att.file);
              content.push({ type: 'text', text: `[Image Attachment: @${att.display}]` });
              content.push({ type: 'image_url', image_url: { url: b64 } });
            } else if (att.file) {
              try {
                // Parse document (Office, PDF, HTML, MHTML, Code, Text) cleanly
                const parsedDoc = await parseAttachmentDocument(att.file);
                
                let fileText = parsedDoc.text;
                // Perform RAG if document has chunks and user provided a query
                // Note: user query might not be available directly here if not last msg, but we can pass textContent
                if (parsedDoc.chunks && parsedDoc.chunkEmbeddings && textContent.trim() && (window as any).electronAPI.ragSearch) {
                  try {
                    const queryEmbedRes = await (window as any).electronAPI.embedTexts([textContent]);
                    if (queryEmbedRes.success && queryEmbedRes.embeddings.length > 0) {
                      const searchRes = await (window as any).electronAPI.ragSearch({
                        queryEmbedding: queryEmbedRes.embeddings[0],
                        chunks: parsedDoc.chunks,
                        chunkEmbeddings: parsedDoc.chunkEmbeddings,
                        topK: 15
                      });
                      
                      if (searchRes.success && searchRes.topChunks) {
                        const topChunks = searchRes.topChunks;
                        const contextString = topChunks.map((c: any) => {
                          const meta = [];
                          if (c.metadata.page !== undefined) meta.push(`Page: ${c.metadata.page}`);
                          if (c.metadata.slide !== undefined) meta.push(`Slide: ${c.metadata.slide}`);
                          const metaStr = meta.length > 0 ? ` | ${meta.join(', ')}` : '';
                          return `[Source: ${c.metadata.source}${metaStr}]\n${c.text}`;
                        }).join('\n\n');
                        
                        fileText = `[RAG Retrieved Context - Showing most relevant excerpts from @${att.display}]\n\n${contextString}`;
                        console.log(`[RAG] Retrieved ${topChunks.length} chunks for ${att.display}`);
                      }
                    }
                  } catch (ragError) {
                    console.error('[RAG Search] Failed:', ragError);
                  }
                }
                
                textContent += `\n\n--- Attachment: @${att.display} ---\n${fileText}\n--- End Attachment ---`;
              } catch (err) {
                console.error("Could not read file", err);
              }
            }
          }
          
          if (textContent) {
            content.unshift({ type: 'text', text: textContent });
          }
          
          if (content.length === 1 && content[0].type === 'text') {
            formattedMessages.push({ role: msg.role, content: textContent });
          } else {
            formattedMessages.push({ role: msg.role, content });
          }
        } else {
          formattedMessages.push({ role: msg.role, content: textContent });
        }
      }

      if (feedbackComments && feedbackComments.length > 0) {
        let feedbackText = "Please regenerate your last response and take into account the following feedback from the user:\n\n";
        feedbackComments.forEach(c => {
          feedbackText += `On your previous text: "${c.quote}"\nUser Comment: "${c.text}"\n\n`;
        });
        formattedMessages.push({ role: 'user', content: feedbackText });
      }

      if (keepThinking) {
        formattedMessages.push({
          role: 'assistant',
          content: `<think>\n${keepThinking}\n</think>\n\n`
        });
      }

      // Multi-round tool execution loop
      let round = 0;
      let accumulatedThinking = keepThinking || '';
      let accumulatedContent = '';
      const allToolCalls: ToolCall[] = [];
      // One thinking chunk per model round: closed when tools execute,
      // reopened when fresh input arrives. Keeps blocks small and chronological.
      const roundThinkingParts: string[] = [];

      while (round < MAX_TOOL_ROUNDS) {
        round++;

        // Read the active model fresh each round so switch_model applies mid-conversation
        const roundModel = activeModelRef.current || targetModel;
        const streamResult = await generateChatStream(roundModel, formattedMessages, update => {
          const currentToolCalls: ToolCall[] = (update.toolCalls || []).map((tc, i) => {
            try {
              const parsed = JSON.parse(tc);
              return {
                id: `${assistantMsgId}-tc-${round}-${i}`,
                name: parsed.name || parsed.toolName || 'tool',
                args: parsed.arguments || parsed.args || {},
                status: 'executing' as const,
                raw: tc
              };
            } catch {
              return {
                id: `${assistantMsgId}-tc-${round}-${i}`,
                name: 'tool',
                args: tc,
                status: 'executing' as const,
                raw: tc
              };
            }
          });

          const combinedToolCalls = [...allToolCalls, ...currentToolCalls];

          setMessages(prev => {
            const newMsgs = [...prev];
            const targetIdx = newMsgs.findIndex(m => m.id === assistantMsgId);
            if (targetIdx !== -1) {
              // Live chunk for the in-flight round; completed rounds stay frozen.
              const liveParts = [...roundThinkingParts];
              if (update.thinking) liveParts[roundThinkingParts.length] = update.thinking;
              newMsgs[targetIdx] = {
                ...newMsgs[targetIdx],
                content: accumulatedContent ? (update.content ? `${accumulatedContent}\n\n${update.content}` : accumulatedContent) : update.content,
                thinking: accumulatedThinking ? (update.thinking ? `${accumulatedThinking}\n\n${update.thinking}` : accumulatedThinking) : update.thinking,
                thinkingParts: liveParts.length > 0 ? liveParts : undefined,
                isGenerating: true,
                toolCalls: combinedToolCalls.length > 0 ? combinedToolCalls : undefined,
                isCallingTool: update.isCallingTool
              };
            }
            return newMsgs;
          });
        }, abortControllerRef.current.signal, undefined, getSystemTools());

        if (streamResult.thinking) {
          accumulatedThinking = accumulatedThinking ? `${accumulatedThinking}\n\n${streamResult.thinking}` : streamResult.thinking;
          // Close this round's chunk — the next round (or tool input) opens a new one.
          roundThinkingParts.push(streamResult.thinking);
        }
        if (streamResult.content) {
          accumulatedContent = accumulatedContent ? `${accumulatedContent}\n\n${streamResult.content}` : streamResult.content;
        }

        const rawCalls = streamResult.toolCalls || [];
        if (rawCalls.length === 0) {
          break;
        }

        // Surface every call in this round as executing immediately
        const roundToolCalls: ToolCall[] = rawCalls.map((raw, i) => {
          let name = 'tool';
          let args: any = {};
          try {
            const parsed = JSON.parse(raw);
            name = parsed.name || parsed.toolName || 'tool';
            args = parsed.arguments || parsed.args || {};
          } catch {
            args = raw;
          }
          return { id: `${assistantMsgId}-tc-${round}-${i}`, name, args, status: 'executing' as const, raw };
        });
        setMessages(prev => {
          const newMsgs = [...prev];
          const targetIdx = newMsgs.findIndex(m => m.id === assistantMsgId);
          if (targetIdx !== -1) {
            newMsgs[targetIdx] = {
              ...newMsgs[targetIdx],
              toolCalls: [...allToolCalls, ...roundToolCalls],
              isGenerating: true
            };
          }
          return newMsgs;
        });

        // Parallel-safe execution: independent calls run concurrently while
        // browser/desktop calls serialize through shared locks.
        const execResults = await executeToolCalls(rawCalls, createToolContext());

        execResults.forEach((er, i) => {
          const tcObj = roundToolCalls[i];
          tcObj.status = er.error ? 'error' : 'completed';
          tcObj.result = er.result;
          if (er.imageDataUrl) tcObj.image = er.imageDataUrl;
        });

        setMessages(prev => {
          const newMsgs = [...prev];
          const targetIdx = newMsgs.findIndex(m => m.id === assistantMsgId);
          if (targetIdx !== -1) {
            newMsgs[targetIdx] = {
              ...newMsgs[targetIdx],
              toolCalls: [...allToolCalls, ...roundToolCalls],
              isGenerating: true
            };
          }
          return newMsgs;
        });

        const roundToolParts: any[] = [];
        for (const er of execResults) {
          roundToolParts.push({ type: 'text', text: `<tool_response tool="${er.toolName}"${er.error ? ' error="true"' : ''}>\n${truncateForContext(er.result)}\n</tool_response>` });
          if (er.imageDataUrl) {
            roundToolParts.push({ type: 'text', text: `[${er.toolName} screenshot attached below]` });
            roundToolParts.push({ type: 'image_url', image_url: { url: er.imageDataUrl } });
          }
        }

        allToolCalls.push(...roundToolCalls);

        formattedMessages.push({
          role: 'assistant',
          content: rawCalls.map((c: string) => `<tool_call>\n${c}\n</tool_call>`).join('\n\n')
        });

        const hasImagePart = roundToolParts.some(p => p.type === 'image_url');
        formattedMessages.push({
          role: 'user',
          content: hasImagePart ? roundToolParts : roundToolParts.map(p => p.text).join('\n\n')
        });
      }

      setMessages(prev => {
        const newMsgs = [...prev];
        const targetIdx = newMsgs.findIndex(m => m.id === assistantMsgId);
        if (targetIdx !== -1) {
          newMsgs[targetIdx] = {
            ...newMsgs[targetIdx],
            content: accumulatedContent,
            thinking: accumulatedThinking,
            toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
            isGenerating: false,
            isCallingTool: false
          };
        }
        return newMsgs;
      });



    } catch (e: any) {
      if (e.name === 'AbortError') {
        console.log('Stream aborted manually');
        return;
      }
      console.error(e);
      const errMsg = (e.message || '').toLowerCase();
      let displayError: string;

      if (errMsg.includes('multimodal') || errMsg.includes('does not support')) {
        displayError = 'Sorry, this model does not support attachments. Please select a vision-capable model (e.g., LLaVA, Gemma 4, Qwen-VL) to use image attachments.';
      } else if (errMsg.includes('invalid image input')) {
        displayError = 'Sorry, this model does not support attachments. The selected model rejected the image input. Try a vision-capable model instead.';
      } else {
        displayError = `**Error:** ${e.message}`;
      }

      setMessages(prev => {
        const newMsgs = [...prev];
        const lastIdx = newMsgs.length - 1;
        if (lastIdx >= 0 && newMsgs[lastIdx].role === 'assistant') {
          newMsgs[lastIdx] = {
            id: newMsgs[lastIdx].id,
            role: 'assistant',
            content: displayError,
            thinking: newMsgs[lastIdx].thinking || '',
            isGenerating: false,
          };
        }
        return newMsgs;
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveEdit = (id: string, type: 'user' | 'thinking' | 'response', text: string, attachments: any[]) => {
    setMessages(prev => {
      const newMsgs = [...prev];
      const idx = newMsgs.findIndex(m => m.id === id);
      if (idx !== -1) {
        if (type === 'user' || type === 'response') {
          newMsgs[idx] = { ...newMsgs[idx], content: text, attachments: attachments.length > 0 ? attachments : undefined };
        } else if (type === 'thinking') {
          newMsgs[idx] = { ...newMsgs[idx], thinking: text };
        }
      }
      return newMsgs;
    });
    setEditingBlock(null);
    setEditPreview(null);
  };

  const handleSaveComment = () => {
    if (!commentInputContext || !commentInputValue.trim()) return;
    setMessages(prev => {
      const newMsgs = [...prev];
      const msgIdx = newMsgs.findIndex(m => m.id === commentInputContext.msgId);
      if (msgIdx !== -1) {
        const msg = newMsgs[msgIdx];
        const newComments = [...(msg.comments || [])];
        newComments.push({
          id: Math.random().toString(36).substring(7),
          quote: commentInputContext.text,
          text: commentInputValue
        });
        newMsgs[msgIdx] = { ...msg, comments: newComments };
      }
      return newMsgs;
    });
    setCommentInputContext(null);
    setCommentInputValue('');
    window.getSelection()?.removeAllRanges();
  };

  const handleSaveActiveComment = () => {
    if (!activeComment || !commentDraft.trim()) return;
    setMessages(prev => {
      const newMsgs = [...prev];
      const msgIdx = newMsgs.findIndex(m => m.id === activeComment.msgId);
      if (msgIdx !== -1) {
        const msg = newMsgs[msgIdx];
        const newComments = (msg.comments || []).map(c =>
          c.id === activeComment.commentId ? { ...c, text: commentDraft } : c
        );
        newMsgs[msgIdx] = { ...msg, comments: newComments };
      }
      return newMsgs;
    });
    setIsCommentPinned(false);
    setActiveComment(null);
  };

  const handleDeleteActiveComment = () => {
    if (!activeComment) return;
    setMessages(prev => {
      const newMsgs = [...prev];
      const msgIdx = newMsgs.findIndex(m => m.id === activeComment.msgId);
      if (msgIdx !== -1) {
        const msg = newMsgs[msgIdx];
        newMsgs[msgIdx] = { ...msg, comments: (msg.comments || []).filter(c => c.id !== activeComment.commentId) };
      }
      return newMsgs;
    });
    setIsCommentPinned(false);
    setActiveComment(null);
  };

  const handleDelete = (id: string, type?: 'user' | 'thinking' | 'response') => {
    setMessages(prev => {
      const newMsgs = [...prev];
      const idx = newMsgs.findIndex(m => m.id === id);
      if (idx === -1) return prev;
      
      if (!type || type === 'user') {
        newMsgs.splice(idx, 1);
      } else if (type === 'thinking') {
        newMsgs[idx] = { ...newMsgs[idx], thinking: '' };
        if (!newMsgs[idx].content && (!newMsgs[idx].toolCalls || newMsgs[idx].toolCalls.length === 0)) newMsgs.splice(idx, 1);
      } else if (type === 'response') {
        newMsgs.splice(idx, 1);
      }
      return newMsgs;
    });
    if (editingBlock?.id === id) {
      setEditingBlock(null);
    }
  };

  const handleRegenerate = async (id: string, type: 'user' | 'thinking' | 'response') => {
    const targetModel = currentModel || lastUsedModel;
    if (!targetModel) return;
    const msgIdx = messages.findIndex(m => m.id === id);
    if (msgIdx === -1) return;
    const msg = messages[msgIdx];
    
    if (type === 'user' || type === 'thinking') {
      const contextMsgs = messages.slice(0, msgIdx);
      setMessages(contextMsgs);
      
      // If we are regenerating a user prompt, wait, if type is 'user', the msgIdx points to the user prompt itself!
      // We need to re-add the user prompt and generate.
      if (type === 'user') {
        const newMsgs = [...contextMsgs, { ...msg }];
        setMessages(newMsgs);
        triggerGeneration(newMsgs, targetModel);
      } else {
        // If type is 'thinking', msgIdx points to the assistant message. We just regenerate it.
        triggerGeneration(contextMsgs, targetModel);
      }
    } else if (type === 'response') {
      const contextMsgs = messages.slice(0, msgIdx);
      setMessages(contextMsgs);
      triggerGeneration(contextMsgs, targetModel, msg.thinking || '', msg.comments);
    }
    setEditingBlock(null);
  };

  // User-initiated kill of the embedded browser (trash icon in Live Browser).
  // The flag is consumed by the agent's next webview tool call so it learns
  // why its session died.
  const handleUserKillBrowser = async () => {
    agentBrowserStore.markUserKilled();
    await terminateBrowserSession();
  };

  // Build unified chronological activity feed from all messages
  // Each activity: { type, messageId, messageIdx, toolCallIdx?, data }
  // Order: user msg → thinking → tool calls → response (per message), messages in array order
  const activityFeed = React.useMemo(() => {
    const activities: any[] = [];
    let lastBrowserActivityIdx = -1;
    
    messages.forEach((msg, msgIdx) => {
      if (msg.role === 'user') {
        activities.push({ type: 'user', messageId: msg.id, messageIdx: msgIdx, data: msg });
      } else if (msg.role === 'assistant') {
        const tcs = msg.toolCalls || [];
        // Chunked thinking: parts[i] precedes tool-call round i+1. Tool ids
        // embed their round (`-tc-${round}-${i}`), so we can interleave exactly.
        const parts = msg.thinkingParts && msg.thinkingParts.length > 0
          ? msg.thinkingParts
          : ((msg.thinking || msg.isGenerating) ? [msg.thinking || ''] : []);
        const toolsByRound = new Map<number, { tc: any, tcIdx: number }[]>();
        let maxRound = 0;
        tcs.forEach((tc: any, tcIdx: number) => {
          const m = String(tc.id || '').match(/-tc-(\d+)-/);
          const r = m ? Number(m[1]) : 1;
          if (!toolsByRound.has(r)) toolsByRound.set(r, []);
          toolsByRound.get(r)!.push({ tc, tcIdx });
          if (r > maxRound) maxRound = r;
        });
        const slots = Math.max(parts.length, maxRound);
        for (let slot = 0; slot < slots; slot++) {
          const partText = parts[slot] || '';
          const isLivePart = !!msg.isGenerating && !msg.isCallingTool && !msg.content && slot === parts.length - 1;
          if (partText.trim() || isLivePart) {
            activities.push({ type: 'thinking', messageId: msg.id, messageIdx: msgIdx, partIdx: slot, text: partText, live: isLivePart, data: msg });
          }
          const roundTools = toolsByRound.get(slot + 1) || [];
          roundTools.forEach(({ tc, tcIdx }) => {
            const toolName = tc.name || tc.toolName || 'tool';
            const isBrowser = toolName.startsWith('browser');
            activities.push({ type: 'tool', messageId: msg.id, messageIdx: msgIdx, toolCallIdx: tcIdx, toolCount: tcs.length, messageIsGenerating: msg.isGenerating, data: { ...tc, toolName, isBrowser } });
            if (isBrowser) {
              lastBrowserActivityIdx = activities.length - 1;
            }
          });
        }
        // Response content
        if (msg.content || (msg.isGenerating && !msg.thinking && !tcs.length)) {
          activities.push({ type: 'response', messageId: msg.id, messageIdx: msgIdx, data: msg });
        }
      }
    });
    
    return { activities, lastBrowserActivityIdx };
  }, [messages]);

  return (
    <div className="flex-1 flex flex-col bg-surface relative">
      
      {/* Main Content */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 flex flex-col items-center overflow-y-auto w-full relative">
        
        {activityFeed.activities.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center w-full px-4">
            <div className="flex flex-col items-center max-w-3xl w-full mt-10">
              <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-6">
                <img src="https://ollama.com/public/icon-64x64.png" alt="Ollama" className="w-10 h-10" onError={(e) => e.currentTarget.style.display = 'none'} />
              </div>
              <h1 className="text-3xl font-semibold text-gray-100 mb-12">How can I help you today?</h1>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-3xl flex flex-col gap-4 py-6 px-4">
            {activityFeed.activities.map((activity, idx) => {
              const isLastBrowser = idx === activityFeed.lastBrowserActivityIdx;

              if (activity.type === 'user') {
                const msg = activity.data;
                const isEditingUser = editingBlock?.id === msg.id && editingBlock?.type === 'user';
                return (
                  <div key={`user-${activity.messageId}`} className="flex flex-col w-full text-gray-100 gap-2 group/msg relative shrink-0" style={{ order: idx * 2 }}>
                    <div className="flex items-center justify-between font-semibold text-sm text-textSecondary">
                      <span>You</span>
                    </div>
                    <div data-msg-id={msg.id} data-msg-type="user" className={`w-full group relative ${isEditingUser ? 'ring-2 ring-accent rounded-lg p-2 -m-2' : ''}`}>
                      {!isGenerating && !msg.isGenerating && (
                        <BlockToolbar 
                          onEdit={() => setEditingBlock({ id: msg.id, type: 'user' })} 
                          onRegenerate={() => handleRegenerate(msg.id, 'user')} 
                          onDelete={() => handleDelete(msg.id, 'user')} 
                        />
                      )}
                      <div className="focus:outline-none [&_.mention]:inline-flex [&_.mention]:items-center [&_.mention]:gap-1.5 [&_.mention]:bg-white/10 [&_.mention]:border [&_.mention]:border-white/5 [&_.mention]:text-accentBright [&_.mention]:px-2 [&_.mention]:h-[24px] [&_.mention]:rounded-md [&_.mention]:mx-1 [&_.mention]:align-middle [&_.mention]:select-none">
                        <ReactMarkdown 
                          remarkPlugins={[remarkGfm, remarkMath]} 
                          rehypePlugins={[rehypeRaw, rehypeKatex]} 
                          components={chatComponents}
                        >
                          {formatMentions(isEditingUser && editPreview ? editPreview.text : msg.content, msg.comments)}
                        </ReactMarkdown>
                      </div>
                      {((isEditingUser && editPreview ? editPreview.attachments : msg.attachments) || []).length > 0 && (
                        <div className="flex gap-2 mt-3 flex-wrap">
                          {((isEditingUser && editPreview ? editPreview.attachments : msg.attachments) || []).map((att: any, aIdx: number) => (
                            <div key={aIdx} className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10 group/att">
                              {att.type === 'image' && att.url ? (
                                <img src={att.url} alt="attached" className="w-full h-full object-cover" />
                              ) : att.thumbnail ? (
                                <img src={att.thumbnail} alt={att.display} className="w-full h-full object-contain p-1 bg-black/20" />
                              ) : (
                                <div className="w-full h-full bg-white/5 flex items-center justify-center text-xs text-textSecondary">File</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }
              
              if (activity.type === 'thinking') {
                const msg = activity.data;
                const isEditingThinking = editingBlock?.id === msg.id && editingBlock?.type === 'thinking';
                return (
                  <div key={`think-${activity.messageId}-${activity.partIdx ?? 0}`} className="flex flex-col w-full text-gray-100 gap-2 group/msg relative shrink-0" style={{ order: idx * 2 }}>
                    <ThinkingBlock 
                      thinking={(isEditingThinking && editPreview) ? editPreview.text : (activity.text || '')} 
                      isGenerating={!!activity.live} 
                    />
                  </div>
                );
              }
              
              if (activity.type === 'tool') {
                const tc = activity.data;
                const toolName = tc.toolName;
                const args = tc.args || tc.arguments || tc;
                const status = tc.status || (activity.messageIsGenerating && activity.toolCallIdx === activity.toolCount - 1 ? 'executing' : 'completed');
                const result = tc.result;
                return (
                  <div key={`tc-${activity.messageId}-${activity.toolCallIdx}`} className="flex flex-col w-full text-gray-100 gap-2 group/msg relative shrink-0" style={{ order: idx * 2 }}>
                    <ToolCallBlock
                      toolName={toolName}
                      args={args}
                      status={status}
                      result={result}
                      imageDataUrl={tc.image}
                      isLiveBrowser={isLastBrowser}
                    />
                  </div>
                );
              }
              
              if (activity.type === 'response') {
                const msg = activity.data;
                const isEditingResponse = editingBlock?.id === msg.id && editingBlock?.type === 'response';
                return (
                  <div key={`resp-${activity.messageId}`} className="flex flex-col w-full text-gray-100 gap-2 group/msg relative shrink-0" style={{ order: idx * 2 }}>
                    <div data-msg-id={msg.id} data-msg-type="response" className={`w-full group relative ${isEditingResponse ? 'ring-2 ring-accent rounded-lg p-2 -m-2' : ''}`}>
                      {!isGenerating && !msg.isGenerating && (
                        <BlockToolbar 
                          onEdit={() => setEditingBlock({ id: msg.id, type: 'response' })} 
                          onRegenerate={() => handleRegenerate(msg.id, 'response')} 
                          onDelete={() => handleDelete(msg.id, 'response')} 
                        />
                      )}
                      <div className="[&_.mention]:inline-flex [&_.mention]:items-center [&_.mention]:gap-1.5 [&_.mention]:bg-white/10 [&_.mention]:border [&_.mention]:border-white/5 [&_.mention]:text-accentBright [&_.mention]:px-2 [&_.mention]:h-[24px] [&_.mention]:rounded-md [&_.mention]:mx-1 [&_.mention]:align-middle [&_.mention]:select-none">
                        <ReactMarkdown 
                          remarkPlugins={[remarkGfm, remarkMath]} 
                          rehypePlugins={[rehypeRaw, rehypeKatex]} 
                          components={chatComponents}
                        >
                          {formatMentions(isEditingResponse && editPreview ? editPreview.text : msg.content, msg.comments) + (msg.isGenerating ? ' ⬤' : '')}
                        </ReactMarkdown>
                      </div>
                    </div>
                  </div>
                );
              }
              
              return null;
            })}
            
            {activityFeed.lastBrowserActivityIdx !== -1 && (
              <div 
                className="w-full shrink-0 transition-all duration-300"
                style={{ order: activityFeed.lastBrowserActivityIdx * 2 + 1 }}
              >
                <div className="w-full overflow-hidden rounded-xl border border-white/10 shadow-lg bg-white/[0.03] backdrop-blur-md">
                  <div
                    onClick={() => setIsBrowserExpanded(!isBrowserExpanded)}
                    className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/[0.05] transition-colors select-none text-xs text-textSecondary group border-b border-white/5"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Globe size={14} className="text-blue-400 shrink-0" />
                      <span className="font-medium text-textSecondary group-hover:text-white transition-colors shrink-0">Live Browser Session</span>
                      <span className="font-mono truncate text-textSecondary/80">Active</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      {agentBrowserStore.getTerminatedSnapshot() ? (
                        <div className="w-2 h-2 rounded-full bg-red-500" title="Browser terminated" />
                      ) : (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleUserKillBrowser(); }}
                            className="p-1 rounded hover:bg-red-500/20 text-textSecondary hover:text-red-400 transition-colors"
                            title="Kill browser session"
                          >
                            <Trash2 size={14} />
                          </button>
                          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        </>
                      )}
                      {isBrowserExpanded ? (
                        <ChevronDown size={14} className="text-textSecondary group-hover:text-gray-200 transition-transform" />
                      ) : (
                        <ChevronRight size={14} className="text-textSecondary group-hover:text-gray-200 transition-transform" />
                      )}
                    </div>
                  </div>
                  
<div className={`transition-all duration-300 ease-in-out origin-top ${isBrowserExpanded ? 'h-[340px] opacity-100 scale-y-100' : 'h-0 opacity-0 scale-y-0'}`}>
                     <div className="w-full h-full relative bg-black/40">
                       {agentBrowserStore.getTerminatedSnapshot() && (
                         <img
                           src={agentBrowserStore.getTerminatedSnapshot()!}
                           alt="Terminated browser session"
                           className="w-full h-full object-cover grayscale opacity-60"
                         />
                       )}
                       {!agentBrowserStore.getTerminatedSnapshot() && <AgentBrowser />}
                     </div>
                   </div>
                </div>
              </div>
            )}

            <div ref={bottomRef} className="w-full shrink-0" style={{ order: 999999 }} />
          </div>
        )}
      </div>

      {/* Tool permission approvals */}
      {pendingApprovals.length > 0 && (
        <div className="fixed bottom-6 right-6 z-[400] flex flex-col gap-3 items-end">
          {pendingApprovals.map(pa => (
            <ApprovalCard key={pa.id} approval={pa} />
          ))}
        </div>
      )}

      {/* Selection Pop-up */}
      {selectionContext && !commentInputContext && (
        <div 
          className="fixed z-50 transform -translate-x-1/2 -translate-y-full pb-2 comment-popup-ui"
          style={{ left: selectionContext.x, top: selectionContext.y }}
        >
          <button
            onClick={() => {
              setCommentInputContext({
                text: selectionContext.text,
                msgId: selectionContext.msgId,
                msgType: selectionContext.msgType
              });
              setCommentInputValue('');
              setSelectionContext(null);
            }}
            className="flex items-center justify-center mac-element text-textSecondary hover:text-gray-200 border border-white/5 shadow-xl p-2 rounded-full transition-transform hover:scale-105"
            title="Add Comment"
          >
            <MessageSquarePlus size={16} />
          </button>
        </div>
      )}

      {/* Comment Input Pop-up (creating a new comment) */}
      {commentInputContext && (
        <div
          className="fixed z-50 transform -translate-x-1/2 -translate-y-full pb-2 comment-popup-ui"
          style={{
            left: selectionContext ? selectionContext.x : window.innerWidth / 2,
            top: selectionContext ? selectionContext.y : window.innerHeight / 2
          }}
        >
          <div className="menu-panel rounded-xl p-3 w-72 flex flex-col gap-2">
            <div className="menu-header">New Comment</div>
            <div className="text-sm italic text-textSecondary border-l-2 border-gray-600 pl-2 line-clamp-2">
              "{commentInputContext.text}"
            </div>
            <textarea
              autoFocus
              value={commentInputValue}
              onChange={(e) => setCommentInputValue(e.target.value)}
              placeholder="Write your comment..."
              className="input-field resize-none min-h-[60px]"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSaveComment();
                }
                if (e.key === 'Escape') {
                  setCommentInputContext(null);
                }
              }}
            />
            <div className="flex justify-end items-center text-sm">
              <button
                onClick={handleSaveComment}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-sm font-medium bg-accent text-white hover:bg-accentHover transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Existing Comment Pop-up — identical UI on hover and click; clicking locks it in */}
      {activeComment && (
        <div
          className="fixed z-50 transform -translate-x-1/2 -translate-y-full pb-2 comment-popup-ui"
          style={{ left: activeComment.x, top: activeComment.y }}
          onMouseEnter={() => { commentPopupHoverRef.current = true; }}
          onMouseLeave={() => {
            commentPopupHoverRef.current = false;
            if (!isCommentPinnedRef.current) setActiveComment(null);
          }}
        >
          <div className="menu-panel rounded-xl p-3 w-72 flex flex-col gap-2">
            <div className="menu-header">Edit Comment</div>
            <div className="text-sm italic text-textSecondary border-l-2 border-gray-600 pl-2 line-clamp-2">
              "{activeComment.quote}"
            </div>
            <textarea
              ref={commentTextareaRef}
              readOnly={!isCommentPinned}
              value={commentDraft}
              onChange={(e) => setCommentDraft(e.target.value)}
              placeholder="Write your comment..."
              className={`input-field resize-none min-h-[60px] ${!isCommentPinned ? 'cursor-default' : ''}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSaveActiveComment();
                }
                if (e.key === 'Escape') {
                  setIsCommentPinned(false);
                  setActiveComment(null);
                }
              }}
            />
            <div className="flex justify-between items-center text-sm">
              <button
                onClick={handleDeleteActiveComment}
                className="text-textSecondary hover:text-white px-2 py-1 rounded"
              >
                Delete
              </button>
              <button
                onClick={handleSaveActiveComment}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-sm font-medium bg-accent text-white hover:bg-accentHover transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input Area */}
            <div className="w-full flex justify-center p-4 bg-gradient-to-t from-surface via-surface to-transparent pt-10">
        <div className="max-w-3xl w-full">
          <ChatInput 
            onSend={handleSendMessage} 
            onStop={handleStop} 
            disabled={isGenerating} 
            editingBlock={editingBlock}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={() => {
              setEditingBlock(null);
              setEditPreview(null);
            }}
            onModelChange={setCurrentModel}
            onEditPreview={(text, attachments) => setEditPreview({ text, attachments })}
            messages={messages}
          />
          <div className="text-center text-xs text-textSecondary mt-3">
            AI models can make mistakes. Verify important information.
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatArea;
