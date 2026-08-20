import React, { useState, useRef, useEffect } from 'react';
import ChatInput from './ChatInput';
import ThinkingBlock from './ThinkingBlock';
import { generateChatStream, LLMModel, fileToBase64, parseAttachmentDocument } from '../utils/llm';
import DEFAULT_SYSTEM_PROMPT from '../utils/systemPrompt.md?raw';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

const MarkdownComponents: any = {
  p: ({node, ...props}: any) => <p className="mb-2 last:mb-0" {...props} />,
  h1: ({node, ...props}: any) => <h1 className="text-2xl font-bold mb-4 mt-6" {...props} />,
  h2: ({node, ...props}: any) => <h2 className="text-xl font-bold mb-3 mt-5" {...props} />,
  h3: ({node, ...props}: any) => <h3 className="text-lg font-bold mb-2 mt-4" {...props} />,
  ul: ({node, ...props}: any) => <ul className="list-disc pl-6 mb-4 space-y-1" {...props} />,
  ol: ({node, ...props}: any) => <ol className="list-decimal pl-6 mb-4 space-y-1" {...props} />,
  li: ({node, ...props}: any) => <li className="leading-relaxed" {...props} />,
  a: ({node, ...props}: any) => <a className="text-blue-400 hover:underline" target="_blank" rel="noopener noreferrer" {...props} />,
  strong: ({node, ...props}: any) => <strong className="font-bold text-gray-100" {...props} />,
  blockquote: ({node, ...props}: any) => <blockquote className="border-l-4 border-gray-500 pl-4 py-1 italic text-gray-400 my-4" {...props} />,
  code: ({node, inline, className, children, ...props}: any) => {
    const match = /language-(\w+)/.exec(className || '');
    return !inline && match ? (
      <div className="rounded-lg overflow-hidden my-4 border border-white/10 bg-[#1e1e1e]">
        <div className="bg-black/40 px-4 py-1 text-xs text-gray-400 flex items-center justify-between border-b border-white/10">
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
      <code {...props} className="bg-white/10 px-1.5 py-0.5 rounded text-sm font-mono text-gray-200">
        {children}
      </code>
    );
  }
};

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  attachments?: any[];
  isGenerating?: boolean;
}

const ChatArea = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  
  const autoScrollEnabled = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    // Tighter tolerance (30px) so deviating slightly detaches the lock smoothly
    const isNearBottom = scrollHeight - scrollTop - clientHeight <= 30;
    autoScrollEnabled.current = isNearBottom;
  };

  // Auto-scroll when messages change or generation updates
  useEffect(() => {
    if (autoScrollEnabled.current) {
      // Use behavior: 'auto' so it doesn't tween constantly on every token, causing jitter
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages]);

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsGenerating(false);
  };

  const allAttachments = messages.flatMap(m => m.attachments || []);

  const formatMentions = (text: string) => {
    if (!text) return text;
    // Match code blocks, inline code, or mentions to strictly avoid replacing within code
    const regex = /(```[\s\S]*?```|`[^`]+`)|(?<![a-zA-Z0-9])@([a-zA-Z0-9_.-]+)/g;
    return text.replace(regex, (match, codeBlock, mention) => {
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
        if (att?.thumbnail) {
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
          <span className="mention inline-flex items-center gap-1.5 bg-white/10 border border-white/5 text-blue-400 px-2 h-[24px] rounded-md mx-1 align-middle select-none">
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

    // Build the user message
    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined
    };

    setMessages(prev => [...prev, userMsg]);
    setIsGenerating(true);
    abortControllerRef.current = new AbortController();

    // Re-enable autoscroll when user sends a message
    autoScrollEnabled.current = true;
    setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);

    try {
      // Format payload for OpenAI-compatible API
      const formattedMessages = [];
      
      // System prompt for multi-attachment focus weighting
      formattedMessages.push({
        role: 'system',
        content: DEFAULT_SYSTEM_PROMPT
      });

      for (const msg of [...messages, userMsg]) {
        let textContent = msg.content || '';

        // If this is a previous assistant turn with thinking, preserve it in the context!
        if (msg.role === 'assistant' && msg.thinking) {
          textContent = `<think>\n${msg.thinking}\n</think>\n\n${textContent}`;
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
                if (parsedDoc.chunks && parsedDoc.chunkEmbeddings && text.trim() && (window as any).electronAPI.ragSearch) {
                  try {
                    const queryEmbedRes = await (window as any).electronAPI.embedTexts([text]);
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
          
          //only send array content if there are images, otherwise send raw text
          if (content.length === 1 && content[0].type === 'text') {
            formattedMessages.push({ role: msg.role, content: textContent });
          } else {
            formattedMessages.push({ role: msg.role, content });
          }
        } else {
          formattedMessages.push({ role: msg.role, content: textContent });
        }
      }

      // Add temporary loading message for assistant
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: '', thinking: '', isGenerating: true }
      ]);

      // Stream chat completion
      await generateChatStream(model, formattedMessages, update => {
        setMessages(prev => {
          const newMsgs = [...prev];
          const lastIdx = newMsgs.length - 1;
          if (lastIdx >= 0 && newMsgs[lastIdx].role === 'assistant') {
            newMsgs[lastIdx] = {
              role: 'assistant',
              content: update.content,
              thinking: update.thinking,
              isGenerating: update.isGenerating,
            };
          }
          return newMsgs;
        });
      }, abortControllerRef.current.signal);

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

  return (
    <div className="flex-1 flex flex-col bg-[#212121] relative">
      
      {/* Main Content */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 flex flex-col items-center overflow-y-auto w-full">
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center w-full px-4">
            <div className="flex flex-col items-center max-w-3xl w-full mt-10">
              <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-6">
                <img src="https://ollama.com/public/icon-64x64.png" alt="Ollama" className="w-10 h-10" onError={(e) => e.currentTarget.style.display = 'none'} />
              </div>
              <h1 className="text-3xl font-semibold text-gray-100 mb-12">How can I help you today?</h1>
            </div>
          </div>
        ) : (
          <div className="w-full max-w-3xl flex flex-col gap-6 py-10 px-4">
            {messages.map((msg, i) => (
              <div key={i} className="flex flex-col w-full text-gray-100 gap-2 mb-4">
                <div className="font-semibold text-sm text-gray-300">
                  {msg.role === 'user' ? 'You' : 'Assistant'}
                </div>
                {msg.role === 'user' ? (
                  <div className="w-full text-gray-100">
                    <div className="focus:outline-none [&_.mention]:inline-flex [&_.mention]:items-center [&_.mention]:gap-1.5 [&_.mention]:bg-white/10 [&_.mention]:border [&_.mention]:border-white/5 [&_.mention]:text-blue-400 [&_.mention]:px-2 [&_.mention]:h-[24px] [&_.mention]:rounded-md [&_.mention]:mx-1 [&_.mention]:align-middle [&_.mention]:select-none">
                        <ReactMarkdown 
                          remarkPlugins={[remarkGfm, remarkMath]} 
                          rehypePlugins={[rehypeRaw, rehypeKatex]} 
                          components={chatComponents}
                        >
                        {formatMentions(msg.content)}
                      </ReactMarkdown>
                    </div>
                    {msg.attachments && (
                      <div className="flex gap-2 mt-3 flex-wrap">
                        {msg.attachments.map(att => (
                          <div key={att.id} className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10">
                            {att.type === 'image' && att.url ? (
                              <img src={att.url} alt="attached" className="w-full h-full object-cover" />
                            ) : att.thumbnail ? (
                              <img src={att.thumbnail} alt={att.display} className="w-full h-full object-contain p-1 bg-black/20" />
                            ) : (
                              <div className="w-full h-full bg-white/5 flex items-center justify-center text-xs text-gray-400">File</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="w-full text-gray-300">
                    {/* Collapsible Thinking Process Block */}
                    {(msg.thinking || (msg.isGenerating && !msg.content)) && (
                      <ThinkingBlock thinking={msg.thinking || ''} isGenerating={msg.isGenerating} />
                    )}

                    {/* Assistant Message Content */}
                    <div className="[&_.mention]:inline-flex [&_.mention]:items-center [&_.mention]:gap-1.5 [&_.mention]:bg-white/10 [&_.mention]:border [&_.mention]:border-white/5 [&_.mention]:text-blue-400 [&_.mention]:px-2 [&_.mention]:h-[24px] [&_.mention]:rounded-md [&_.mention]:mx-1 [&_.mention]:align-middle [&_.mention]:select-none">
                      {msg.content ? (
                        <ReactMarkdown 
                          remarkPlugins={[remarkGfm, remarkMath]} 
                          rehypePlugins={[rehypeRaw, rehypeKatex]} 
                          components={chatComponents}
                        >
                          {formatMentions(msg.content)}
                        </ReactMarkdown>
                      ) : msg.isGenerating && !msg.thinking ? (
                        <div className="flex items-center gap-2 text-gray-400 text-sm h-6">
                          <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse"></div>
                          <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse delay-75"></div>
                          <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse delay-150"></div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="w-full flex justify-center p-4 bg-gradient-to-t from-[#212121] via-[#212121] to-transparent pt-10">
        <div className="max-w-3xl w-full">
          <ChatInput onSend={handleSendMessage} onStop={handleStop} disabled={isGenerating} />
          <div className="text-center text-xs text-gray-500 mt-3">
            AI models can make mistakes. Verify important information.
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatArea;
