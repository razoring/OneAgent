import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Brain, Copy, Check, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ThinkingBlockProps {
  thinking: string;
  isGenerating?: boolean;
}

export const ThinkingBlock: React.FC<ThinkingBlockProps> = ({ thinking, isGenerating }) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(!!isGenerating);
  const [copied, setCopied] = useState(false);

  // Auto-expand when generating starts, auto-collapse when generating finishes if not manually modified
  useEffect(() => {
    if (isGenerating) {
      setIsExpanded(true);
    }
  }, [isGenerating]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(thinking);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!thinking && !isGenerating) return null;

  return (
    <div className="w-full my-2 rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-md overflow-hidden transition-all duration-200">
      {/* Header */}
      <div 
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/[0.05] transition-colors select-none text-xs text-gray-400 group"
      >
        <div className="flex items-center gap-2">
          {isGenerating ? (
            <Loader2 className="w-3.5 h-3.5 text-accentBright animate-spin" />
          ) : (
            <Brain className="w-3.5 h-3.5 text-gray-400 group-hover:text-gray-300 transition-colors" />
          )}
          <span className="font-medium text-gray-300 group-hover:text-white transition-colors">
            {isGenerating ? 'Thinking...' : 'Thought Process'}
          </span>
          <span className="text-[10px] text-gray-400 bg-white/5 px-1.5 py-0.5 rounded border border-white/5">
            {isExpanded ? 'Hide' : 'Show'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {thinking && (
            <button
              onClick={handleCopy}
              title="Copy thinking process"
              className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-gray-200 transition-colors"
            >
              {copied ? <Check className="w-3 h-3 text-white" /> : <Copy className="w-3 h-3" />}
            </button>
          )}
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400 group-hover:text-gray-200 transition-transform" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400 group-hover:text-gray-200 transition-transform" />
          )}
        </div>
      </div>

      {/* Collapsible Content */}
      {isExpanded && (
        <div className="px-3.5 py-2.5 border-t border-white/5 text-xs text-gray-300 font-mono leading-relaxed max-h-[350px] overflow-y-auto whitespace-pre-wrap bg-black/20 select-text">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {thinking || '...'}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
};

export default ThinkingBlock;
