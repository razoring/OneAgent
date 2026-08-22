import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight, ChevronDown, Check, X, Terminal, FileCode, Search, Globe, MousePointer2, Loader2, Bot, SlidersHorizontal } from 'lucide-react';
import { ChevronRight, ChevronDown, Check, X, Terminal, FileCode, Search, Globe, MousePointer2, Loader2, Bot, SlidersHorizontal } from 'lucide-react';
interface ToolCallBlockProps {
  toolName: string;
  args: any;
  status: 'executing' | 'completed' | 'error';
  result?: string;
  imageDataUrl?: string;
  isLiveBrowser?: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  run_command: 'Terminal',
  view_file: 'Read File',
  list_dir: 'List Directory',
  search_files: 'Search Files',
  write_to_file: 'Write File',
  replace_file_content: 'Edit File',
  delete_file: 'Delete File',
  search_web: 'Web Search',
  browser_navigate: 'Browser',
  browser_go_back: 'Browser',
  browser_get_dom: 'Page DOM',
  browser_type: 'Browser Type',
  browser_scroll: 'Scroll',
  browser_screenshot: 'Browser Screenshot',
  browser_observe: 'Observe Page',
  browser_click: 'Virtual Click',
  browser_mouse_down: 'Mouse Hold',
  browser_mouse_up: 'Mouse Release',
  browser_mouse_move: 'Mouse Move',
  browser_drag: 'Virtual Drag',
  browser_key: 'Keypress',
  browser_evaluate: 'Run JS',
  browser_cookies: 'Cookies',
  browser_history: 'History',
  browser_storage: 'Page Storage',
  browser_select_option: 'Select Option',
  browser_wait_for: 'Wait For',
  find_in_page: 'Find In Page',
  browser_download: 'Download',
  browser_set_user_agent: 'User-Agent',
  desktop_screenshot: 'Screenshot',
  desktop_click: 'Desktop Control',
  desktop_drag: 'Desktop Control',
  desktop_type: 'Desktop Control',
  desktop_hotkey: 'Desktop Hotkey',
  list_models: 'List Models',
  get_settings: 'Agent Settings',
  get_model_stats: 'Model Stats',
  switch_model: 'Switch Model',
  update_settings: 'Update Settings',
  spawn_agent: 'Spawn Sub-Agent',
  check_agents: 'Check Sub-Agents'
};

const SELF_MOD_TOOLS = new Set(['list_models', 'get_settings', 'get_model_stats', 'switch_model', 'update_settings']);
const AGENT_TOOLS = new Set(['spawn_agent', 'check_agents']);

const getToolIcon = (name: string) => {
  if (AGENT_TOOLS.has(name)) return <Bot size={15} className="text-cyan-400 shrink-0" />;
  if (SELF_MOD_TOOLS.has(name)) return <SlidersHorizontal size={15} className="text-pink-400 shrink-0" />;
  if (name.includes('file') || name.includes('dir')) return <FileCode size={15} className="text-blue-400 shrink-0" />;
  if (name.includes('command')) return <Terminal size={15} className="text-green-400 shrink-0" />;
  if (name.includes('search') || name === 'find_in_page') return <Search size={15} className="text-orange-400 shrink-0" />;
  if (name.includes('browser')) return <Globe size={15} className="text-indigo-400 shrink-0" />;
  if (name.startsWith('desktop')) return <MousePointer2 size={15} className="text-purple-400 shrink-0" />;
  return <Terminal size={15} className="text-gray-400 shrink-0" />;
};

const basename = (p?: string) => (p ? p.split(/[/\\]/).pop() : undefined);

const getToolSummary = (name: string, args: any): string => {
  try {
    switch (name) {
      case 'run_command': return args?.command || '';
      case 'view_file': return basename(args?.path ?? args?.AbsolutePath) || '';
      case 'list_dir': return (args?.path ?? args?.DirectoryPath) || '';
      case 'search_files': return `"${args?.query || ''}"${args?.path ? ` in ${args.path}` : ''}`;
      case 'write_to_file': return basename(args?.path ?? args?.targetFile) || '';
      case 'replace_file_content': return basename(args?.path ?? args?.targetFile) || '';
      case 'delete_file': return basename(args?.path ?? args?.filePath) || '';
      case 'search_web': return args?.query || '';
      case 'browser_navigate': return args?.url || '';
      case 'browser_type': return args?.text ? `"${String(args.text).slice(0, 40)}"` : '';
      case 'browser_scroll': return args?.direction || 'down';
      case 'browser_click': {
        const target = args?.id != null ? `#${args.id}` : `(${args?.x ?? '?'}, ${args?.y ?? '?'})`;
        const btn = args?.button && args.button !== 'left' ? ` ${args.button}` : '';
        const cc = (args?.click_count ?? 1) > 1 ? ` x${args.click_count}` : '';
        return `${target}${btn}${cc}`;
      }
      case 'browser_drag': {
        const from = args?.from_id != null ? `#${args.from_id}` : `(${args?.from_x ?? '?'}, ${args?.from_y ?? '?'})`;
        const to = args?.to_id != null ? `#${args.to_id}` : `(${args?.to_x ?? '?'}, ${args?.to_y ?? '?'})`;
        return `${from} → ${to}`;
      }
      case 'browser_key': return [ ...(args?.modifiers || []), args?.key ].filter(Boolean).join('+');
      case 'browser_evaluate': return String(args?.script || '').slice(0, 60);
      case 'browser_cookies': return `${args?.op || 'get'}${args?.name ? ` ${args.name}` : ''}`;
      case 'browser_history': return `${args?.op || 'list'}${args?.index != null ? ` → ${args.index}` : ''}`;
      case 'browser_storage': return `${args?.op || 'get'}${args?.key ? ` ${args.key}` : ''} (${args?.type || 'local'})`;
      case 'browser_select_option': return args?.value ? `#${args.id} → "${args.value}"` : '';
      case 'browser_wait_for': return `"${args?.selector_or_text || ''}"`;
      case 'find_in_page': return `"${args?.text || ''}"`;
      case 'browser_download': return basename(args?.url) || args?.url || '';
      case 'browser_set_user_agent': return args?.ua ? String(args.ua).slice(0, 48) + '…' : 'reset';
      case 'desktop_click': return args ? `(${args.x ?? '?'}, ${args.y ?? '?'})` : '';
      case 'desktop_hotkey': return (args?.keys || []).join('+');
      case 'switch_model': return args?.model ? `${args.provider ? args.provider + '/' : ''}${args.model}` : '';
      case 'update_settings': return Object.entries(args || {}).map(([k, v]) => `${k}=${String(v).slice(0, 20)}`).join(' ');
      case 'spawn_agent': return args?.label || String(args?.task || '').slice(0, 50);
      case 'check_agents': return Array.isArray(args?.agent_ids) ? `${args.agent_ids.length} agent(s)` : 'all';
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

      // Sub-agent reports
      if (Array.isArray(parsed.agents)) {
        return parsed.agents.map((a: any) =>
          `${a.label || a.id} [${a.status}]${a.steps ? ` (${a.steps} tool calls)` : ''}${a.result ? `\n→ ${String(a.result).slice(0, 400)}` : ''}${a.error ? `\n→ Error: ${a.error}` : ''}`
        ).join('\n\n');
      }
      if (parsed.agent_id) {
        return `${parsed.agent_id} — ${parsed.status || 'spawned'}${parsed.note ? `\n${parsed.note}` : ''}`;
      }
      // Model listing
      if (Array.isArray(parsed.providers)) {
        return parsed.providers.map((pr: any) => `${pr.id}: ${pr.models.join(', ') || '(no models)'}`).join('\n');
      }
      // Settings / stats snapshots
      if (parsed.settings && (parsed.tokenUsage || parsed.activeModel !== undefined)) {
        const s = parsed.settings;
        const t = parsed.tokenUsage?.totals;
        return [
          `Active: ${parsed.activeModel ? `${parsed.activeModel.provider}/${parsed.activeModel.id}` : 'none'}`,
          `temp=${s.temperature} top_p=${s.topP} thinking=${s.thinkingLevel}`,
          `max_out=${s.maxOutputLength} ctx=${s.contextWindow}`,
          t ? `Session tokens: ${t.promptTokens.toLocaleString()} in / ${t.completionTokens.toLocaleString()} out` : '',
          Array.isArray(parsed.loadedModels) ? parsed.loadedModels.map((m: any) => `${m.provider}: ${m.summary}`).join('\n') : ''
        ].filter(Boolean).join('\n');
      }
      if (Array.isArray(parsed.items)) {
        return parsed.items.map((i: any) => `${i.isDir ? '[dir]  ' : ''}${i.name}${i.sizeBytes ? `  (${i.sizeBytes} B)` : ''}`).join('\n');
      }
      if (Array.isArray(parsed.matches)) {
        return parsed.matches.map((m: any) => `${m.file}:${m.lineNumber}: ${m.line.trim().slice(0, 160)}`).join('\n').slice(0, 4000);
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

const ToolCallBlock: React.FC<ToolCallBlockProps> = ({ toolName, args, status, result, imageDataUrl, isLiveBrowser }) => {
  const [expanded, setExpanded] = useState(false);
  const userToggled = useRef(false);
  const isScreenshotTool = toolName === 'desktop_screenshot' || toolName === 'browser_screenshot' || toolName === 'browser_observe';
  const isBrowserTool = toolName.startsWith('browser');

  // Auto-expand while running, then fold back into the stack shortly after
  // completion — unless the user took manual control of this block.
  useEffect(() => {
    if (userToggled.current) return;
    if (status === 'executing') {
      setExpanded(true);
      return;
    }
    const t = setTimeout(() => setExpanded(false), 1500);
    return () => clearTimeout(t);
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

      {/* Screenshot preview — visible only while the block is expanded (non-browser tools or non-live browser) */}
      {expanded && isScreenshotTool && status === 'completed' && imageDataUrl && !isLiveBrowser && (
        <div className="px-3 pb-3 pt-0.5">
          <img
            src={imageDataUrl}
            alt={`${label} capture`}
            className="w-full rounded-lg border border-white/10 bg-black/20"
          />
        </div>
      )}

      {/* Collapsible body — exact input + output */}
      {expanded && (
        <div className="border-t border-white/5 bg-black/20">

          <div className="px-3.5 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-textSecondary mb-1.5">Input</div>
            <pre className="text-xs font-mono leading-relaxed text-gray-200 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto select-text">
              {toolName === 'run_command' && args?.command ? `$ ${args.command}` : JSON.stringify(args ?? {}, null, 2)}
            </pre>
          </div>

          {status !== 'executing' && !(isScreenshotTool && imageDataUrl) && (
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
