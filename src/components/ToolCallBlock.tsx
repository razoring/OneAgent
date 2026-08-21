import React, { useState } from 'react';
import { ChevronRight, ChevronDown, Check, X, Terminal, FileCode, Search, Globe, MousePointer2 } from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface ToolCallBlockProps {
  toolName: string;
  args: string | any;
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'error';
  result?: string;
  onApprove?: () => void;
  onReject?: () => void;
}

const getToolIcon = (name: string) => {
  if (name.includes('file') || name.includes('dir')) return <FileCode size={16} className="text-blue-400" />;
  if (name.includes('command')) return <Terminal size={16} className="text-green-400" />;
  if (name.includes('search') || name.includes('grep')) return <Search size={16} className="text-orange-400" />;
  if (name.includes('browser') || name.includes('web')) return <Globe size={16} className="text-indigo-400" />;
  if (name.includes('desktop')) return <MousePointer2 size={16} className="text-purple-400" />;
  return <Terminal size={16} className="text-gray-400" />;
};

const getToolTitle = (name: string, args: any) => {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    if (name === 'view_file') return `Viewed ${parsed.AbsolutePath?.split(/[/\\]/).pop()}`;
    if (name === 'write_to_file') return `Created ${parsed.TargetFile?.split(/[/\\]/).pop()}`;
    if (name === 'replace_file_content') return `Edited ${parsed.TargetFile?.split(/[/\\]/).pop()}`;
    if (name === 'run_command') return `Ran \`${parsed.CommandLine}\``;
    if (name === 'grep_search') return `Searched for "${parsed.Query}"`;
    return `Called ${name}`;
  } catch {
    return `Called ${name}`;
  }
};

const ToolCallBlock: React.FC<ToolCallBlockProps> = ({ toolName, args, status, result, onApprove, onReject }) => {
  const [expanded, setExpanded] = useState(false);
  const title = getToolTitle(toolName, args);
  const isDestructive = toolName === 'write_to_file' || toolName === 'replace_file_content' || toolName === 'run_command' || toolName === 'delete_file';
  
  const formattedArgs = typeof args === 'string' ? args : JSON.stringify(args, null, 2);

  return (
    <div className="my-3 border border-white/10 bg-[#1e1e1e] rounded-lg overflow-hidden">
      <div 
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={16} className="text-textSecondary" /> : <ChevronRight size={16} className="text-textSecondary" />}
          {getToolIcon(toolName)}
          <span className="text-sm font-medium text-gray-200">{title}</span>
          
          {status === 'pending' && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-yellow-500/20 text-yellow-500 border border-yellow-500/30">Needs Approval</span>}
          {status === 'executing' && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30">Executing...</span>}
          {status === 'completed' && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-500/20 text-green-400 border border-green-500/30">Done</span>}
          {status === 'error' && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">Failed</span>}
        </div>
      </div>
      
      {expanded && (
        <div className="p-3 border-t border-white/5 bg-black/30">
          <div className="text-xs text-textSecondary mb-1 font-medium uppercase tracking-wider">Arguments</div>
          <SyntaxHighlighter
            language="json"
            style={vscDarkPlus}
            customStyle={{ margin: 0, padding: '0.75rem', borderRadius: '0.5rem', background: '#121212', fontSize: '0.8125rem' }}
          >
            {formattedArgs}
          </SyntaxHighlighter>
          
          {result && (
            <div className="mt-3">
              <div className="text-xs text-textSecondary mb-1 font-medium uppercase tracking-wider">Result</div>
              <SyntaxHighlighter
                language="json"
                style={vscDarkPlus}
                customStyle={{ margin: 0, padding: '0.75rem', borderRadius: '0.5rem', background: '#121212', fontSize: '0.8125rem' }}
              >
                {result}
              </SyntaxHighlighter>
            </div>
          )}
          
          {status === 'pending' && isDestructive && (
            <div className="mt-4 flex gap-2">
              <button 
                onClick={(e) => { e.stopPropagation(); onApprove?.(); }}
                className="flex items-center gap-1.5 bg-green-600/20 text-green-400 hover:bg-green-600/30 border border-green-500/30 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              >
                <Check size={16} /> Approve
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); onReject?.(); }}
                className="flex items-center gap-1.5 bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-500/30 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
              >
                <X size={16} /> Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallBlock;
