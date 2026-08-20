import React, { useState, useRef, useEffect } from 'react';
import ChatInput from './ChatInput';
import { generateChatResponse, LLMModel, fileToBase64 } from '../utils/llm';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
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
  role: 'user' | 'assistant';
  content: string;
  attachments?: any[];
  isGenerating?: boolean;
}

const ChatArea = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

    try {
      // Format payload for OpenAI-compatible API
      const formattedMessages = [];
      for (const msg of [...messages, userMsg]) {
        let textContent = msg.content || '';
        
        if (msg.attachments && msg.attachments.length > 0) {
          const content = [];
          
          for (const att of msg.attachments) {
            if (att.type === 'image' && att.file) {
              const b64 = await fileToBase64(att.file);
              content.push({ type: 'image_url', image_url: { url: b64 } });
            } else if (att.file) {
              try {
                const fileText = await att.file.text();
                textContent += `\n\n--- Attachment: ${att.display} ---\n${fileText}\n--- End Attachment ---`;
              } catch (err) {
                console.error("Could not read file", err);
              }
            }
          }
          
          if (textContent) {
            content.unshift({ type: 'text', text: textContent });
          }
          
          // Only send array content if there are images, otherwise send raw text (better compatibility)
          if (content.length === 1 && content[0].type === 'text') {
            formattedMessages.push({ role: msg.role, content: textContent });
          } else {
            formattedMessages.push({ role: msg.role, content });
          }
        } else {
          formattedMessages.push({ role: msg.role, content: textContent });
        }
      }

      // Add temporary loading message
      setMessages(prev => [...prev, { role: 'assistant', content: '', isGenerating: true }]);

      const responseText = await generateChatResponse(model, formattedMessages);

      setMessages(prev => {
        const newMsgs = [...prev];
        newMsgs[newMsgs.length - 1] = { role: 'assistant', content: responseText };
        return newMsgs;
      });

    } catch (e: any) {
      console.error(e);
      setMessages(prev => {
        const newMsgs = [...prev];
        newMsgs[newMsgs.length - 1] = { role: 'assistant', content: `**Error:** ${e.message}` };
        return newMsgs;
      });
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-[#212121] relative">
      
      {/* Main Content */}
      <div className="flex-1 flex flex-col items-center overflow-y-auto w-full">
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
                    <div className="focus:outline-none [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1.5 [&>span]:bg-white/10 [&>span]:border [&>span]:border-white/5 [&>span]:text-blue-400 [&>span]:px-2 [&>span]:h-[24px] [&>span]:rounded-md [&>span]:mx-1 [&>span]:align-middle [&>span]:select-none">
                      <ReactMarkdown 
                        remarkPlugins={[remarkGfm]} 
                        rehypePlugins={[rehypeRaw]} 
                        components={MarkdownComponents}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                    {msg.attachments && (
                      <div className="flex gap-2 mt-3 flex-wrap">
                        {msg.attachments.map(att => (
                          <div key={att.id} className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/10">
                            {att.type === 'image' && att.url ? (
                              <img src={att.url} alt="attached" className="w-full h-full object-cover" />
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
                    {msg.isGenerating ? (
                      <div className="flex items-center gap-2 text-gray-400 text-sm h-6">
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse"></div>
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse delay-75"></div>
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-pulse delay-150"></div>
                      </div>
                    ) : (
                      <ReactMarkdown 
                        remarkPlugins={[remarkGfm]} 
                        rehypePlugins={[rehypeRaw]} 
                        components={MarkdownComponents}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    )}
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
          <ChatInput onSend={handleSendMessage} disabled={isGenerating} />
          <div className="text-center text-xs text-gray-500 mt-3">
            AI models can make mistakes. Verify important information.
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatArea;
