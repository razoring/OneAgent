import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, ChevronRight, Copy, Check, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ThinkingBlockProps {
  thinking: string;
  isGenerating?: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking, isGenerating }) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(!!isGenerating);
  const [userToggled, setUserToggled] = useState<boolean>(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [finalDuration, setFinalDuration] = useState<number | null>(null);
  const startRef = useRef<number | null>(null);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottomRef = useRef(true);

  // Auto-scroll logic
  useEffect(() => {
    if (isExpanded && isScrolledToBottomRef.current && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [thinking, isExpanded]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    isScrolledToBottomRef.current = Math.abs(scrollHeight - clientHeight - scrollTop) < 10;
  };

  // Open while thinking, fold back into the stack when done — unless the user took control
  useEffect(() => {
    if (!userToggled) setIsExpanded(!!isGenerating);
  }, [isGenerating, userToggled]);

  // Track thinking duration
  useEffect(() => {
    if (isGenerating) {
      if (startRef.current === null) {
        startRef.current = Date.now();
      }
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - (startRef.current ?? Date.now())) / 1000));
      }, 500);
      return () => clearInterval(interval);
    } else if (startRef.current !== null) {
      setFinalDuration(Math.max(1, Math.round((Date.now() - startRef.current) / 1000)));
    }
  }, [isGenerating]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(thinking);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggle = () => {
    setUserToggled(true);
    setIsExpanded(!isExpanded);
    if (!isExpanded) {
      isScrolledToBottomRef.current = true; // reset scroll tracking when expanding
    }
  };

  if (!thinking && !isGenerating) return null;

  return (
    <div className="w-full my-2 rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-md overflow-hidden transition-all duration-200">
      {/* Header */}
      <div 
        onClick={handleToggle}
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/[0.05] transition-colors select-none text-xs text-textSecondary group"
      >
        <div className="flex items-center gap-2">
          {isGenerating ? (
            <Loader2 className="w-3.5 h-3.5 text-accentBright animate-spin" />
          ) : (
            <Check className="w-3.5 h-3.5 text-green-400" />
          )}
          <span className="font-medium text-textSecondary group-hover:text-white transition-colors">
            {isGenerating
              ? `Thinking for ${elapsed}s`
              : finalDuration !== null
                ? `Thought for ${finalDuration}s`
                : 'Thought Process'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {thinking && (
            <button
              onClick={handleCopy}
              title="Copy thinking process"
              className="p-1 rounded hover:bg-white/10 text-textSecondary hover:text-gray-200 transition-colors"
            >
              {copied ? <Check className="w-3 h-3 text-white" /> : <Copy className="w-3 h-3" />}
            </button>
          )}
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-textSecondary group-hover:text-gray-200 transition-transform" />
          ) : (
            <ChevronRight className="w-4 h-4 text-textSecondary group-hover:text-gray-200 transition-transform" />
          )}
        </div>
      </div>

      {/* Collapsible Content */}
      {isExpanded && (
        <div 
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="px-3.5 py-2.5 border-t border-white/5 text-xs text-textSecondary font-mono leading-relaxed max-h-[350px] overflow-y-auto whitespace-pre-wrap bg-black/20 select-text"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {thinking || '...'}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
};

export default ThinkingBlock;
