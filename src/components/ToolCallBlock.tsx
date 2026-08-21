import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronDown, Check, X, Terminal, FileCode, Search, Globe, MousePointer2, Loader2 } from 'lucide-react';
import AgentBrowser from './AgentBrowser';

interface ToolCallBlockProps {
  toolName: string;
  args: any;
  status: 'executing' | 'completed' | 'error';
  result?: string;
  isBrowserHost?: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  run_command: 'Terminal',
  view_file: 'Read File',
  list_dir: 'List Directory',
  write_to_file: 'Write File',
  replace_file_content: 'Edit File',
  delete_file: 'Delete File',
  search_web: 'Web Search',
  browser_navigate: 'Browser',
  browser_go_back: 'Browser',
  browser_get_dom: 'Browser',
  browser_visual_capture: 'Browser',
  browser_interact: 'Browser',
  desktop_screenshot: 'Screenshot',
  desktop_click: 'Desktop Control',
  desktop_type: 'Desktop Control',
};

const getToolIcon = (name: string) => {
  if (name.includes('file') || name.includes('dir')) return <FileCode size={15} className="text-blue-400 shrink-0" />;
  if (name.includes('command')) return <Terminal size={15} className="text-green-400 shrink-0" />;
  if (name.includes('search')) return <Search size={15} className="text-orange-400 shrink-0" />;
  if (name.includes('browser') || name.includes('web')) return <Globe size={15} className="text-indigo-400 shrink-0" />;
  if (name.includes('desktop')) return <MousePointer2 size={15} className="text-purple-400 shrink-0" />;
  return <Terminal size={15} className="text-gray-400 shrink-0" />;
};

const basename = (p?: string) => (p ? p.split(/[/\\]/).pop() : undefined);

const getToolSummary = (name: string, args: any): string => {
  try {
    switch (name) {
      case 'run_command': return args?.command || '';
      case 'view_file': return basename(args?.AbsolutePath) || '';
      case 'list_dir': return args?.DirectoryPath || '';
      case 'write_to_file': return basename(args?.targetFile) || '';
      case 'replace_file_content': return basename(args?.targetFile) || '';
      case 'delete_file': return basename(args?.filePath) || '';
      case 'search_web': return args?.query || '';
      case 'browser_navigate': return args?.url || '';
      default: return '';
    }
  } catch {
    return '';
  }
};

// Turns the raw JSON tool output into human-readable terminal-style output
const formatOutput = (result?: string): string => {
  if (!result) return '';
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === 'object') {
      const parts: string[] = [];
      if (typeof parsed.stdout === 'string' && parsed.stdout.trim()) parts.push(parsed.stdout.trimEnd());
      if (typeof parsed.stderr === 'string' && parsed.stderr.trim()) parts.push(parsed.stderr.trimEnd());
      if (parsed.error) parts.push(`Error: ${parsed.error}`);
      if (parts.length > 0) return parts.join('\n');
      if (Array.isArray(parsed.items)) {
        return parsed.items.map((i: any) => `${i.isDir ? '[dir]  ' : ''}${i.name}${i.sizeBytes ? `  (${i.sizeBytes} B)` : ''}`).join('\n');
      }
      if (typeof parsed.content === 'string') return parsed.content;
      if (parsed.success === false) return `Error: ${parsed.error || 'Unknown error'}`;
      if (parsed.success === true) return 'Completed successfully';
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // plain-text result (e.g. browser tools)
  }
  return result;
};

const ToolCallBlock: React.FC<ToolCallBlockProps> = ({ toolName, args, status, result, isBrowserHost }) => {
  const [expanded, setExpanded] = useState(status === 'executing');
  const userToggled = useRef(false);
  const isBrowserTool = toolName.startsWith('browser');

  // Auto-open while running and when the output arrives, unless the user took control
  useEffect(() => {
    if (!userToggled.current && (status === 'executing' || status === 'completed' || status === 'error')) {
      setExpanded(true);
    }
  }, [status]);

  const label = TOOL_LABELS[toolName] || toolName;
  const summary = getToolSummary(toolName, args);
  const output = formatOutput(result);

  return (
    <div className="w-full rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-md overflow-hidden transition-all duration-200">
      {/* Header — always visible summary */}
      <div
        onClick={() => { userToggled.current = true; setExpanded(!expanded); }}
        className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/[0.05] transition-colors select-none text-xs text-textSecondary group"
      >
        <div className="flex items-center gap-2 min-w-0">
          {getToolIcon(toolName)}
          <span className="font-medium text-textSecondary group-hover:text-white transition-colors shrink-0">{label}</span>
          {summary && <span className="font-mono truncate text-textSecondary/80">{summary}</span>}
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-2">
          {status === 'executing' && <Loader2 size={13} className="animate-spin text-accentBright" />}
          {status === 'completed' && <Check size={14} className="text-green-400" />}
          {status === 'error' && <X size={14} className="text-red-400" />}
          {expanded ? (
            <ChevronDown size={14} className="text-textSecondary group-hover:text-gray-200 transition-transform" />
          ) : (
            <ChevronRight size={14} className="text-textSecondary group-hover:text-gray-200 transition-transform" />
          )}
        </div>
      </div>

      {/* Collapsible body — live browser view (host block only) + exact input + output */}
      {expanded && (
        <div className="border-t border-white/5 bg-black/20">
          {isBrowserTool && isBrowserHost && (
            <AgentBrowser />
          )}

          <div className="px-3.5 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-textSecondary mb-1.5">Input</div>
            <pre className="text-xs font-mono leading-relaxed text-gray-200 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto select-text">
              {toolName === 'run_command' && args?.command ? `$ ${args.command}` : JSON.stringify(args ?? {}, null, 2)}
            </pre>
          </div>

          {status !== 'executing' && (
            <div className="px-3.5 pb-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-textSecondary mb-1.5">Output</div>
              <pre className={`text-xs font-mono leading-relaxed whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto select-text ${status === 'error' ? 'text-red-300' : 'text-textSecondary'}`}>
                {output || (status === 'completed' ? 'Completed successfully' : '')}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolCallBlock;
