import React, { useState, useRef, useEffect } from 'react';
import ChatInput from './ChatInput';
import ThinkingBlock from './ThinkingBlock';
import ToolCallBlock from './ToolCallBlock';
import { generateChatStreamWithRetry, generateChatResponse, condenseThinking, stripSimulatedDebris, LLMModel, fileToBase64, parseAttachmentDocument, getModelStats } from '../utils/llm';
import { getAgentsSnapshot, getAgentTranscript, runApprovedSteps, StepRunResult } from '../utils/subAgents';
import { classifyNeedsExecution, extractSteps, heuristicNeedsExecution, PlanStep } from '../utils/delegation';
import { chatStore, transcriptToMessages } from '../utils/chatStore';
import { ORCHESTRATOR_PROMPT as DEFAULT_SYSTEM_PROMPT } from '../utils/prompts';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { MessageSquarePlus, Terminal, Globe, ChevronDown, ChevronRight, ChevronLeft, Trash2, Bug, Settings2 } from 'lucide-react';
import { agentBrowserStore } from '../utils/agentBrowserStore';
import { terminateBrowserSession } from '../utils/browserTools';
import LiveEmbeddedContainer from './LiveEmbeddedContainer';
import { transcriptStore } from '../utils/transcriptStore';
import { userPromptStore } from '../utils/userPromptStore';
import { taskListStore } from '../utils/taskListStore';
import { ChatComment, ToolCall, ChatMessage } from '../types/chat';

export type { ChatComment, ToolCall, ChatMessage };

const MarkdownComponents: any = {
  p: ({ node, ...props }: any) => <p className="mb-2 last:mb-0" {...props} />,
  h1: ({ node, ...props }: any) => <h1 className="text-2xl font-bold mb-4 mt-6" {...props} />,
  h2: ({ node, ...props }: any) => <h2 className="text-xl font-bold mb-3 mt-5" {...props} />,
  h3: ({ node, ...props }: any) => <h3 className="text-lg font-bold mb-2 mt-4" {...props} />,
  ul: ({ node, ...props }: any) => <ul className="list-disc pl-6 mb-4 space-y-1" {...props} />,
  ol: ({ node, ...props }: any) => <ol className="list-decimal pl-6 mb-4 space-y-1" {...props} />,
  li: ({ node, ...props }: any) => <li className="leading-relaxed" {...props} />,
  a: ({ node, ...props }: any) => <a className="text-accentBright hover:underline" target="_blank" rel="noopener noreferrer" {...props} />,
  strong: ({ node, ...props }: any) => <strong className="font-bold text-gray-100" {...props} />,
  blockquote: ({ node, ...props }: any) => <blockquote className="border-l-4 border-gray-500 pl-4 py-1 italic text-textSecondary my-4" {...props} />,
  code: ({ node, inline, className, children, ...props }: any) => {
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

// ─── Debug transcript ────────────────────────────────────────────────────────
// Compact, LLM-parseable format: flattened metadata, a round-by-round timeline
// with relative timestamps and full per-round thinking, then the exact model
// context. Designed so token cost stays low while retaining everything needed
// to debug model behavior (thinking style, stalls, recovery, tool results).
const fmtTs = (t?: number) => (t ? new Date(t).toISOString() : '?');
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const oneLine = (v: any, max = 300): string => {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  if (s == null) s = 'null';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max}ch)` : s;
};
const blockText = (v: any, max: number): string => {
  let s: string;
  try { s = typeof v === 'string' ? v : JSON.stringify(v, null, 1); } catch { s = String(v); }
  return s == null ? '' : (s.length > max ? s.slice(0, max) + `\n…[+${s.length - max} chars truncated]` : s);
};
// Multimodal message parts → compact string ([image] placeholders for blobs).
const msgToText = (content: any): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) =>
    p?.type === 'image_url' ? '[image attached]' : (p?.text ?? '')).join('\n');
  return JSON.stringify(content);
};

const buildTranscript = (msg: ChatMessage): string => {
  const L: string[] = [];
  const t0 = msg.createdAt;
  const calls = msg.toolCalls || [];
  const dur = t0 && msg.completedAt ? secs(msg.completedAt - t0) : '?';
  const at = (t?: number) => (t0 && t ? `t+${secs(t - t0)}` : 't+?');

  L.push(`# OneAgent Transcript ${msg.id}`);
  L.push(`window ${fmtTs(t0)} → ${fmtTs(msg.completedAt)} | dur ${dur} | rounds ${calls.length}/${MAX_TOOL_ROUNDS} | generating ${!!msg.isGenerating}`);

  // Model & settings snapshot — flattened, no JSON dumps.
  if (msg.modelStats) {
    const m = msg.modelStats;
    if (m.activeModel) L.push(`model: ${m.activeModel.id ?? '?'} @ ${m.activeModel.provider ?? '?'}`);
    const s = m.settings || {};
    L.push(`settings: think=${s.thinkingLevel ?? '?'} thinkTO=${s.thinkingTimeout ?? 0}s temp=${s.temperature ?? '?'} topP=${s.topP ?? '?'} maxTok=${s.maxOutputLength ?? '?'} ctx=${s.contextWindow ?? '?'}`);
    const u = m.totals || m.usage?.totals;
    if (u) L.push(`usage: prompt=${u.promptTokens ?? 0} completion=${u.completionTokens ?? 0}`);
  }

  // Round timeline. thinkingParts[i] is the reasoning that preceded round i+1's
  // tool calls; call timestamps give inter-round gaps (thinking + exec time).
  const byRound = new Map<number, ToolCall[]>();
  calls.forEach(tc => {
    const m = /-tc-(\d+)-/.exec(tc.id || '');
    const r = m ? parseInt(m[1], 10) : calls.indexOf(tc) + 1;
    if (!byRound.has(r)) byRound.set(r, []);
    byRound.get(r)!.push(tc);
  });
  const parts = msg.thinkingParts;

  if (byRound.size > 0) {
    L.push('\n## Timeline');
    let prevTs: number | undefined = t0;
    Array.from(byRound.keys()).sort((a, b) => a - b).forEach(r => {
      const roundCalls = byRound.get(r)!;
      const firstTs = roundCalls[0]?.timestamp;
      const gap = prevTs && firstTs ? secs(firstTs - prevTs) : '?';
      const think = parts?.[r - 1];
      const recovery = [];
      if (think) {
        if (think.includes('[Thinking timeout')) recovery.push('think-timeout');
        if (think.includes('[Auto-continued')) recovery.push('auto-continue');
      }
      L.push(`\n### R${r} Δ${gap}${recovery.length ? ' ⚑ ' + recovery.join('+') : ''}`);
      if (think && think.trim()) {
        L.push(`think[${think.length}c]:`);
        blockText(think, 4000).split('\n').forEach(line => L.push(`| ${line}`));
      }
      roundCalls.forEach(tc => {
        L.push(`[${at(tc.timestamp)}] ${tc.name} → ${tc.status}`);
        L.push(`  args: ${oneLine(tc.args)}`);
        if (tc.result !== undefined) L.push(`  result: ${oneLine(tc.result, 400)}`);
        if (tc.image) L.push('  result: [image]');
        prevTs = tc.timestamp;
      });
    });
  } else if (msg.thinking && msg.thinking.trim()) {
    L.push(`\n## Thinking [${msg.thinking.length}c]`);
    blockText(msg.thinking, 6000).split('\n').forEach(line => L.push(`| ${line}`));
  }

  if (msg.content && msg.content.trim()) {
    L.push(`\n## Final Answer [${msg.content.length}c]`);
    L.push(blockText(msg.content, 2000));
  }

  // The exact messages sent to the model — the ground truth of what it saw,
  // including reasoning_digest blocks and tool_call serialization.
  if (msg.internalContext && msg.internalContext.length > 0) {
    L.push('\n## Model Context (verbatim)');
    msg.internalContext.forEach((m: any, i: number) => {
      const body = msgToText(m.content);
      L.push(`\n[${i + 1}] ${m.role} (${body.length}c)`);
      L.push(blockText(body, 1800));
    });
  }

  if (msg.comments && msg.comments.length > 0) {
    L.push('\n## User Comments');
    msg.comments.forEach(c => L.push(`- on "${oneLine(c.quote, 80)}": ${oneLine(c.text, 200)}`));
  }

  return L.join('\n');
};

const downloadTranscript = () => {
  const blob = new Blob([transcriptStore.get()], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `oneagent-transcript-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// Safety cap so a model stuck in tool-call loops can't run forever
const MAX_TOOL_ROUNDS = 10;

const BlockToolbar = ({ onEdit, onRegenerate, onDelete }: { onEdit?: () => void, onRegenerate?: () => void, onDelete?: () => void }) => {
  return (
    <div className="absolute -top-[38px] right-0 pb-1.5 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-20">
      <div className="flex items-center gap-1 mac-element p-1 rounded-full border border-white/5 shadow-sm">
        {onEdit && (
          <button onClick={onEdit} className="p-1.5 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors" title="Edit">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></svg>
          </button>
        )}
        {onRegenerate && (
          <button onClick={onRegenerate} className="p-1.5 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors" title="Regenerate">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></svg>
          </button>
        )}
        {onDelete && (
          <button onClick={onDelete} className="p-1.5 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors" title="Delete">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" /><line x1="10" x2="10" y1="11" y2="17" /><line x1="14" x2="14" y1="11" y2="17" /></svg>
          </button>
        )}
      </div>
    </div>
  );
};

const UnifiedToolsBlock = ({ activity, isGenerating, msgIsGenerating, activityFeed, isBrowserExpanded, setIsBrowserExpanded, handleUserKillBrowser, _browserSessionId, onEdit, onRegenerate, onDelete }: any) => {
  const { toolCalls } = activity.data;
  const [expanded, setExpanded] = useState(true);
  const isLatestBrowserBlock = activityFeed.lastBrowserToolsMessageId === activity.messageId;

  // Terminated-session snapshot (grayscale overlay over the live slot).
  const [terminatedSnap, setTerminatedSnap] = useState<string | null>(agentBrowserStore.getTerminatedSnapshot());
  useEffect(() => agentBrowserStore.subscribeSnapshot(setTerminatedSnap), []);
  // No teleport — LiveEmbeddedContainer parks headless offscreen when not visible,
  // so tools keep working without needing a global fixed layer.

  return (
    <div className="w-full group relative">
      {!isGenerating && !msgIsGenerating && (
        <BlockToolbar
          onEdit={onEdit}
          onRegenerate={onRegenerate}
          onDelete={onDelete}
        />
      )}
      <div className="w-full rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-md overflow-hidden transition-all duration-200">
        <div
          onClick={() => setExpanded(!expanded)}
          className="px-3 py-2 text-xs text-textSecondary flex items-center justify-between border-b border-white/5 cursor-pointer hover:bg-white/[0.05] transition-colors group/header"
        >
          <div className="flex items-center gap-2">
            <Terminal size={14} className="text-gray-400" />
            <span className="font-medium group-hover/header:text-white transition-colors">Tool Calls</span>
            <span className="font-mono text-textSecondary/80">{toolCalls.length} call{toolCalls.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="text-textSecondary group-hover/header:text-gray-200 transition-colors">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
        </div>

        {expanded && (
          <div className="p-2 flex flex-col gap-2 bg-black/20">
            {toolCalls.map((tc: any, i: number) => {
              const toolName = tc.name || tc.toolName || 'tool';
              const args = tc.args || tc.arguments || tc;
              const status = tc.status || (msgIsGenerating && i === toolCalls.length - 1 ? 'executing' : 'completed');
              const result = tc.result;
              const isBrowser = toolName.startsWith('browser');
              const isLastBrowser = isBrowser && i === toolCalls.findLastIndex((t: any) => (t.name || t.toolName || '').startsWith('browser'));
              return (
                <ToolCallBlock
                  key={`tc-${activity.messageId}-${i}`}
                  toolName={toolName}
                  args={args}
                  status={status}
                  result={result}
                  imageDataUrl={tc.image}
                  isLiveBrowser={isLastBrowser}
                />
              );
            })}
          </div>
        )}

        {/* Live Browser — always visible at the bottom of this tools block,
            styled flush with the container: same header palette, rounded
            bottom corners via the parent's clip, square inner corners. */}
        {activityFeed.lastBrowserToolsMessageId === activity.messageId && (
          <>
            <div
              onClick={() => setIsBrowserExpanded(!isBrowserExpanded)}
              className="px-3 py-2 text-xs text-textSecondary flex items-center justify-between border-t border-white/5 cursor-pointer hover:bg-white/[0.05] transition-colors select-none group/header"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Globe size={14} className={terminatedSnap ? 'text-red-400 shrink-0' : 'text-blue-400 shrink-0'} />
                <span className="font-medium group-hover/header:text-white transition-colors shrink-0">Live Browser Session</span>
                {terminatedSnap && <span className="text-[10px] font-mono text-red-400">terminated</span>}
              </div>
              <div className="flex items-center gap-2 shrink-0 ml-2 text-textSecondary group-hover/header:text-gray-200 transition-colors">
                {!terminatedSnap && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleUserKillBrowser(); }}
                      className="p-1 rounded hover:bg-red-500/20 hover:text-red-400 transition-colors"
                      title="Kill browser session"
                    >
                      <Trash2 size={14} />
                    </button>
                    <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  </>
                )}
                {isBrowserExpanded ? (
                  <ChevronDown size={14} className="transition-transform" />
                ) : (
                  <ChevronRight size={14} className="transition-transform" />
                )}
              </div>
            </div>

            {isBrowserExpanded && (
              <div className="relative bg-black/20">
                <div className="w-full aspect-video px-2 pb-2">
                  <LiveEmbeddedContainer isVisible={isLatestBrowserBlock && isBrowserExpanded && !terminatedSnap} />
                </div>
                {terminatedSnap && (
                  <img
                    src={terminatedSnap}
                    alt="Terminated browser session"
                    className="absolute inset-0 w-full h-full object-cover grayscale"
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const ChatArea = ({ onToggleSettings }: { onToggleSettings?: () => void }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  // Home chat (root conversation the user types into) + nested view state.
  // While a nested chat is open, `messages` keeps holding the home
  // conversation untouched; the feed renders `nestedMessages` instead.
  const homeChatIdRef = useRef<string | null>(null);
  const [homeChatId, setHomeChatId] = useState<string | null>(null);
  // Set only once `messages` actually holds the loaded content of homeChatId —
  // prevents autosaving stale messages into a freshly-switched chat.
  const loadedChatIdRef = useRef<string | null>(null);
  const [viewingNested, setViewingNested] = useState<{ chatId: string; agentId?: string } | null>(null);
  const [nestedMessages, setNestedMessages] = useState<ChatMessage[]>([]);
  const [nestedMeta, setNestedMeta] = useState<{ title: string; parentId: string | null } | null>(null);

  // Incremented at every generation start — forces the browser adoption
  // effect to re-run (message ids alone don't change across regenerates) and
  // remounts a guaranteed-fresh webview for each new session.
  const [browserSessionId, setBrowserSessionId] = useState(0);

  // Debug-transcript availability — button only shows after a generation completes.
  const [hasTranscript, setHasTranscript] = useState(transcriptStore.get().length > 0);
  useEffect(() => transcriptStore.subscribe(t => setHasTranscript(t.length > 0)), []);

  // Startup: initialize the store, then load the active (home) chat.
  useEffect(() => {
    void (async () => {
      await chatStore.initOnce();
      const id = chatStore.getActiveId();
      if (!id) return;
      homeChatIdRef.current = id;
      setHomeChatId(id);
      try {
        const msgs = await chatStore.loadMessages(id);
        setMessages(msgs);
        loadedChatIdRef.current = id;
      } catch (e) {
        console.error('[ChatArea] failed to load chat', e);
      }
    })();
    const flush = () => chatStore.flushSaves();
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  // React to sidebar navigation: switching the active chat swaps the home
  // conversation and closes any nested view.
  useEffect(() => chatStore.subscribeActive(id => {
    if (!id || id === homeChatIdRef.current) return;
    chatStore.flushSaves();
    loadedChatIdRef.current = null;
    homeChatIdRef.current = id;
    setHomeChatId(id);
    setViewingNested(null);
    setNestedMessages([]);
    setNestedMeta(null);
    setEditingBlock(null);
    setEditPreview(null);
    autoScrollEnabled.current = true;
    void chatStore.loadMessages(id)
      .then(msgs => {
        // Ignore stale loads if the user switched again mid-flight.
        if (homeChatIdRef.current !== id) return;
        setMessages(msgs);
        loadedChatIdRef.current = id;
      })
      .catch(e => console.error('[ChatArea] failed to load chat', e));
  }), []);

  // Tasks-panel inspection: open the agent's persisted nested chat. The chat
  // is created at spawn time, so retry briefly if it hasn't landed yet.
  useEffect(() => {
    const h = (e: Event) => {
      const agentId = String((e as CustomEvent).detail || '');
      let tries = 0;
      const attempt = () => {
        const chatId = chatStore.getChatIdForAgent(agentId)
          ?? chatStore.getChats().find(c => c.agentId === agentId)?.id;
        if (chatId) {
          openNestedChat(chatId);
          return;
        }
        if (++tries < 10) setTimeout(attempt, 250);
      };
      attempt();
    };
    window.addEventListener('inspect-agent', h);
    return () => window.removeEventListener('inspect-agent', h);
  }, []);

  // Open a nested (sub-agent) chat: disk-backed for finished agents, live-
  // polled from the in-memory transcript while the agent still runs.
  const openNestedChat = async (chatId: string) => {
    chatStore.flushSaves();
    const meta = chatStore.getMeta(chatId);
    if (!meta) return;
    setNestedMeta({ title: meta.title, parentId: meta.parentId });
    setViewingNested({ chatId, ...(meta.agentId ? { agentId: meta.agentId } : {}) });
    setEditingBlock(null);
    setEditPreview(null);
    autoScrollEnabled.current = true;
    // Show the agent's own browser tab (created on demand) so the user sees
    // exactly what this sub-agent is looking at.
    if (meta.agentId) {
      const tab = agentBrowserStore.ensureAgentTab(meta.agentId, meta.title);
      agentBrowserStore.activateTab(tab.id);
    }
    try {
      const stored = await chatStore.loadMessages(chatId);
      setNestedMessages(stored);
    } catch { setNestedMessages([]); }
    setTimeout(() => bottomRef.current?.scrollIntoView(), 50);
  };

  const backToParentChat = () => {
    setViewingNested(null);
    setNestedMessages([]);
    autoScrollEnabled.current = true;
    setTimeout(() => bottomRef.current?.scrollIntoView(), 50);
  };

  // Live transcript polling while viewing a running agent's nested chat.
  const viewingAgentId = viewingNested?.agentId;
  useEffect(() => {
    if (!viewingAgentId) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const agent = getAgentsSnapshot([viewingAgentId])[0];
      if (!agent) return;
      setNestedMessages(transcriptToMessages(getAgentTranscript(viewingAgentId)));
      if (agent.status !== 'queued' && agent.status !== 'running') return; // terminal — stop
      timer = setTimeout(tick, 600);
    };
    let timer: any = setTimeout(tick, 50);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [viewingAgentId]);

  // Keep the nested header title in sync with renames. Guards against
  // re-render cascades: only set when something actually changed.
  useEffect(() => chatStore.subscribeChats(list => {
    if (!viewingNested?.chatId) return;
    const meta = list.find(c => c.id === viewingNested.chatId);
    if (!meta) return;
    setNestedMeta(prev =>
      prev && prev.title === meta.title && prev.parentId === meta.parentId
        ? prev
        : { title: meta.title, parentId: meta.parentId }
    );
  }), [viewingNested?.chatId]);

  // Edit mode tracking
  const [editingBlock, setEditingBlock] = useState<{ id: string, type: 'user' | 'thinking' | 'response' | 'tools' } | null>(null);
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
  const [isBrowserExpanded, setIsBrowserExpanded] = useState(true);
  const commentPopupHoverRef = useRef(false);
  const isCommentPinnedRef = useRef(false);
  const commentTextareaRef = useRef<HTMLTextAreaElement>(null);

  const autoScrollEnabled = useRef(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Permission-gated tool approvals + agent questions — rendered inline in the
  // chat input via userPromptStore (no floating popups).
  const APPROVAL_LABELS: Record<string, string> = {
    run_command: 'Run shell command',
    delete_file: 'Delete file',
    switch_model: 'Switch agent model',
    update_settings: 'Change agent parameters',
    desktop_click: 'Control your mouse',
    desktop_drag: 'Control your mouse',
    desktop_type: 'Type on your keyboard',
    desktop_hotkey: 'Press system hotkey'
  };

  const requestApproval = async (toolName: string, summary: string): Promise<{ approved: boolean; message?: string }> => {
    const label = APPROVAL_LABELS[toolName] || `Allow ${toolName}`;
    const response = await userPromptStore.enqueue({
      kind: 'approval',
      title: label,
      detail: summary || undefined,
      options: ['Approve once', 'Approve always', 'Deny']
    });
    if (response && /^Approve/i.test(response)) return { approved: true };
    // "Deny" or a custom explanation counts as denial; custom text is passed
    // back to the model so it understands WHY.
    return { approved: false, message: response && !/^Deny$/i.test(response) ? response : undefined };
  };
  // The model the agent loop should use — switchable mid-conversation by the agent itself.
  const activeModelRef = useRef<LLMModel | null>(null);
  useEffect(() => {
    activeModelRef.current = currentModel || lastUsedModel;
  }, [currentModel, lastUsedModel]);

  const flushPendingApprovals = () => {
    userPromptStore.flush();
  };

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

  // Autosave the home conversation (debounced; capped wait keeps long
  // generations checkpointed). Nested chats are persisted by subAgents.ts.
  useEffect(() => {
    const chatId = homeChatIdRef.current;
    if (!chatId || chatId !== loadedChatIdRef.current || viewingNested || !chatStore.isReady) return;
    chatStore.saveMessagesDebounced(chatId, messages);
  }, [messages, homeChatId, viewingNested]);

  // Finalize any in-flight assistant message so per-block toolbars
  // (edit / regenerate / delete) become available after a manual stop.
  const finalizeGeneratingMessages = () => {
    setMessages(prev => {
      const newMsgs = [...prev];
      for (let i = newMsgs.length - 1; i >= 0; i--) {
        if (newMsgs[i].isGenerating) {
          newMsgs[i] = { ...newMsgs[i], isGenerating: false, isCallingTool: false };
          break;
        }
      }
      return newMsgs;
    });
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    flushPendingApprovals();
    setIsGenerating(false);
    finalizeGeneratingMessages();
  };

  // Auto-title: after the first exchange of a default-titled chat, ask the
  // model for a concise name. Falls back to the truncated first message.
  const titleInFlight = useRef(false);
  const maybeGenerateTitle = async (contextMsgs: ChatMessage[], targetModel: LLMModel, answer: string) => {
    const chatId = homeChatIdRef.current;
    if (!chatId || titleInFlight.current) return;
    const meta = chatStore.getMeta(chatId);
    if (!meta || (meta.title !== 'New Chat' && meta.title !== '')) return;
    const firstUserText = contextMsgs.find(m => m.role === 'user')?.content?.trim() || '';
    if (!firstUserText && !answer.trim()) return;

    titleInFlight.current = true;
    const fallback = () => {
      const source = firstUserText || answer;
      const t = source.replace(/\s+/g, ' ').slice(0, 48).trim();
      if (t) void chatStore.rename(chatId, t).catch(() => { });
    };
    try {
      const raw = await generateChatResponse(
        activeModelRef.current || targetModel,
        [
          { role: 'system', content: 'You generate concise chat titles. Reply with ONLY the title: 2 to 6 words, no quotes, no trailing punctuation, no explanation.' },
          { role: 'user', content: `First user message:\n${firstUserText.slice(0, 800)}\n\nAssistant reply excerpt:\n${answer.slice(0, 600)}` }
        ]
      );
      const title = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/["'`\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      // Another window may have renamed/titled this chat meanwhile.
      const current = chatStore.getMeta(chatId);
      if (!current || (current.title !== 'New Chat' && current.title !== '')) return;
      if (title) await chatStore.rename(chatId, title);
      else fallback();
    } catch {
      fallback();
    } finally {
      titleInFlight.current = false;
    }
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
      return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></svg>;
    } else if (type === 'folder') {
      return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" /></svg>;
    } else {
      return <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>;
    }
  };

  const chatComponents = {
    ...MarkdownComponents,
    span: ({ node, className, ...props }: any) => {
      const mentionFile = props['data-mention'];
      if (mentionFile) {
        let att = allAttachments.find(a => a.display === mentionFile);
        let icon = null;
        if (att?.thumbnail && att?.type === 'image') {
          icon = <img src={att.thumbnail} style={{ width: 14, height: 14, objectFit: 'contain' }} />;
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

  // ─── Guided delegation pipeline ────────────────────────────────────────────
  // The app drives the protocol; the LLM only writes prose:
  //   DRAFT (tools-free) → CLASSIFY → GATE (app card, no auto-proceed)
  //   → EXTRACT steps → SPAWN/COLLECT agents → SYNTHESIZE

  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  interface DelegationRow extends PlanStep {
    status: 'queued' | 'running' | 'retrying' | 'done' | 'error';
    resultSummary?: string;
    agentId?: string;
  }
  const [delegation, setDelegation] = useState<{ steps: DelegationRow[] } | null>(null);

  const buildFormatted = async (contextMsgs: ChatMessage[]): Promise<any[]> => {
    const formattedMessages: any[] = [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }];
    for (const msg of contextMsgs) {
      let textContent = msg.content || '';
      if (msg.role === 'assistant' && msg.thinking) {
        textContent = `<think>\n${condenseThinking(msg.thinking)}\n</think>\n\n${textContent}`;
      }
      if (msg.comments && msg.comments.length > 0) {
        textContent += `\n\n--- User annotations on this message ---\n`;
        msg.comments.forEach(c => { textContent += `On text: "${c.quote}"\nAnnotation: "${c.text}"\n`; });
      }
      if (msg.attachments && msg.attachments.length > 0) {
        const content: any[] = [];
        for (const att of msg.attachments) {
          if (att.type === 'image' && att.file) {
            content.push({ type: 'text', text: `[Image Attachment: @${att.display}]` });
            content.push({ type: 'image_url', image_url: { url: await fileToBase64(att.file) } });
          } else if (att.file) {
            try {
              const parsedDoc = await parseAttachmentDocument(att.file);
              textContent += `\n\n--- Attachment: @${att.display} ---\n${parsedDoc.text}\n--- End Attachment ---`;
            } catch (err) { console.error('Could not read file', err); }
          }
        }
        if (textContent) content.unshift({ type: 'text', text: textContent });
        formattedMessages.push(content.length === 1 ? { role: msg.role, content: textContent } : { role: msg.role, content });
      } else {
        formattedMessages.push({ role: msg.role, content: textContent });
      }
    }
    return formattedMessages;
  };

  // One tools-free assistant turn (draft / synthesis / regeneration). Writes
  // a normal annotatable message and returns its final text.
  const streamAssistantTurn = async (
    contextMsgs: ChatMessage[],
    targetModel: LLMModel,
    phase: 'draft' | 'synthesis'
  ): Promise<string> => {
    setIsGenerating(true);
    setBrowserSessionId(id => id + 1);
    transcriptStore.set('');
    // NOTE: the turn-level AbortController is owned by runConversationTurn —
    // it must SURVIVE this function (the Proceed card listens on it after the
    // draft completes). Never null or replace it here.
    autoScrollEnabled.current = true;
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

    const msgId = Math.random().toString(36).substring(7);
    const startedAt = Date.now();
    // Functional update: messagesRef may still be one render behind right
    // after the user message was added — appending to prev guarantees the
    // user's prompt stays in the list.
    setMessages(prev => [...prev, { id: msgId, role: 'assistant', content: '', isGenerating: true }]);

    try {
      const model = activeModelRef.current || targetModel;
      const formatted = await buildFormatted(contextMsgs);
      const res = await generateChatStreamWithRetry(model, formatted, update => {
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === msgId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], content: update.content, thinking: update.thinking, isGenerating: true };
          return next;
        });
      }, abortControllerRef.current?.signal);

      const clean = stripSimulatedDebris(res.content || '').trim();
      const thinking = res.thinking || '';
      setMessages(prev => prev.map(m => (m.id === msgId
        ? { ...m, content: clean, thinking, isGenerating: false, isCallingTool: false, createdAt: startedAt, completedAt: Date.now() }
        : m)));

      const finalMsg: ChatMessage = {
        id: msgId, role: 'assistant', content: clean, thinking,
        isGenerating: false, createdAt: startedAt, completedAt: Date.now()
      };
      try { let stats: any = null; stats = await getModelStats(activeModelRef.current || targetModel); finalMsg.modelStats = stats; } catch {}
      transcriptStore.set(buildTranscript(finalMsg));
      if (phase === 'draft') maybeGenerateTitle(contextMsgs, targetModel, clean);
      return clean;
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        finalizeGeneratingMessages();
        return '';
      }
      console.error(`[ChatArea] ${phase} turn failed`, e);
      setMessages(prev => prev.map(m => (m.id === msgId
        ? { ...m, content: `**Error:** ${e?.message || e}`, isGenerating: false }
        : m)));
      return '';
    } finally {
      setIsGenerating(false);
    }
  };

  // App-owned confirmation card. Blocks until the user Proceeds, writes
  // feedback, or stops. Never auto-proceeds.
  const askProceedCard = async (): Promise<{ answer: string | null; annotations: { quote: string; text: string }[] }> => {
    const signal = abortControllerRef.current?.signal;
    const promise = userPromptStore.enqueue({ kind: 'ask', title: 'Ready to proceed?', options: ['Proceed'] });
    const aborted = new Promise<null>(resolve => {
      if (!signal) return resolve(null);
      if (signal.aborted) return resolve(null);
      signal.addEventListener('abort', () => resolve(null), { once: true });
    });
    const answer = await Promise.race([promise, aborted]);
    // Snapshot annotations made on the draft while the card was open.
    const lastAssistant = [...messagesRef.current].reverse().find(m => m.role === 'assistant');
    const annotations = (lastAssistant?.comments || []).map(c => ({ quote: c.quote, text: c.text }));
    if (answer === null) { userPromptStore.flush(); return { answer: null, annotations: [] }; }
    return { answer, annotations };
  };

  const runConversationTurn = async (initialMsgs: ChatMessage[], targetModel: LLMModel) => {
    abortControllerRef.current = new AbortController();
    setDelegation(null);
    let currentMsgs = initialMsgs;

    // ── DRAFT (+ revision loop — user stays in control, no auto-proceed)
    let draftText = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      draftText = await streamAssistantTurn(currentMsgs, targetModel, 'draft');
      if (abortControllerRef.current?.signal.aborted || !draftText.trim()) return;

      const lastUserText = [...currentMsgs].reverse().find(m => m.role === 'user')?.content || '';
      let agentic = await classifyNeedsExecution(activeModelRef.current || targetModel, lastUserText, draftText);
      if (agentic === null) agentic = heuristicNeedsExecution(lastUserText, draftText);
      if (agentic === false) return; // conversational — plain chat reply, done

      const { answer, annotations } = await askProceedCard();
      if (answer === null) return; // stopped
      if (answer === 'Proceed' && annotations.length === 0) break;

      // Feedback → append it and produce a revised draft.
      const feedbackParts: string[] = [];
      if (answer !== 'Proceed') feedbackParts.push(answer);
      annotations.forEach(a => feedbackParts.push(`On "${a.quote.slice(0, 100)}": ${a.text}`));
      const fbMsg: ChatMessage = {
        id: Math.random().toString(36).substring(7),
        role: 'user',
        content: `[Feedback on your reply]\n${feedbackParts.join('\n')}`
      };
      currentMsgs = [...messagesRef.current, fbMsg];
      setMessages(currentMsgs);
    }

    // ── APPROVED → extract steps from the approved draft
    const model = activeModelRef.current || targetModel;
    let steps: PlanStep[] = [];
    try { steps = await extractSteps(model, draftText); } catch { steps = []; }
    if (steps.length === 0) {
      await streamAssistantTurn(
        [...messagesRef.current, { id: Math.random().toString(36).substring(7), role: 'user', content: '[System] No delegable steps were detected in the approved reply. If this task needs web/file work, state the steps explicitly; otherwise the reply above stands as your answer.' }],
        targetModel,
        'synthesis'
      );
      return;
    }

    // ── DELEGATE + COLLECT
    setDelegation({ steps: steps.map(s => ({ ...s, status: 'queued' })) });
    let results: StepRunResult[] = [];
    try {
      results = await runApprovedSteps(steps, {
        getModel: () => activeModelRef.current || model,
        requestApproval,
        signal: abortControllerRef.current?.signal,
        parentChatId: homeChatIdRef.current,
        onProgress: u => setDelegation(d => d ? { steps: d.steps.map((s, k) => (k === u.index ? { ...s, status: u.status, resultSummary: u.resultSummary ?? s.resultSummary, agentId: u.agentId ?? s.agentId } : s)) } : d)
      });
    } catch (e: any) {
      console.error('[ChatArea] delegation failed', e);
      setDelegation(null);
      await streamAssistantTurn(
        [...messagesRef.current, { id: Math.random().toString(36).substring(7), role: 'user', content: `[System] Delegation failed to start: ${e?.message || e}` }],
        targetModel,
        'synthesis'
      );
      return;
    }
    if (abortControllerRef.current?.signal.aborted) return;

    // ── SYNTHESIZE
    setDelegation(d => d ? { steps: d.steps.map(s => ({ ...s, status: results[d.steps.indexOf(s)]?.status ?? s.status })) } : d);
    const reportsBlock = results.map((r, i) =>
      `[Agent Report] Step ${i + 1}: ${r.step.title} — ${r.status.toUpperCase()}\n${(r.report || r.error || '(no output)').slice(0, 4000)}`
    ).join('\n\n');
    const reportsMsg: ChatMessage = {
      id: Math.random().toString(36).substring(7),
      role: 'user',
      content: `[System] All approved steps finished. Their reports follow — synthesize them into the final answer for the user.\n\n${reportsBlock}`
    };
    await streamAssistantTurn([...messagesRef.current, reportsMsg], targetModel, 'synthesis');
  };

  const handleSendMessage = async (text: string, attachments: any[], model: LLMModel) => {
    if (!text.trim() && attachments.length === 0) return;
    setLastUsedModel(model);

    const userMsg: ChatMessage = {
      id: Math.random().toString(36).substring(7),
      role: 'user',
      content: text,
      attachments: attachments.length > 0 ? attachments : undefined
    };

    const newMsgs = [...messagesRef.current, userMsg];
    setMessages(newMsgs);

    // A fresh prompt starts a new delegation cycle — clear the old task tree.
    taskListStore.reset();
    setDelegation(null);
    await runConversationTurn(newMsgs, model);
  };

  const handleSaveEdit = (id: string, type: 'user' | 'thinking' | 'response' | 'tools', text: string, attachments: any[]) => {
    setMessages(prev => {
      const newMsgs = [...prev];
      const idx = newMsgs.findIndex(m => m.id === id);
      if (idx !== -1) {
        if (type === 'user' || type === 'response') {
          newMsgs[idx] = { ...newMsgs[idx], content: text, attachments: attachments.length > 0 ? attachments : undefined };
        } else if (type === 'thinking') {
          newMsgs[idx] = { ...newMsgs[idx], thinking: text };
        }
        // 'tools' type is not directly editable in the input area
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

  const handleDelete = (id: string, type?: 'user' | 'thinking' | 'response' | 'tools') => {
    setMessages(prev => {
      const newMsgs = [...prev];
      const idx = newMsgs.findIndex(m => m.id === id);
      if (idx === -1) return prev;

      if (!type || type === 'user') {
        newMsgs.splice(idx, 1);
      } else if (type === 'thinking') {
        newMsgs[idx] = { ...newMsgs[idx], thinking: '', thinkingParts: undefined };
        if (!newMsgs[idx].content && (!newMsgs[idx].toolCalls || newMsgs[idx].toolCalls.length === 0)) newMsgs.splice(idx, 1);
      } else if (type === 'response') {
        newMsgs.splice(idx, 1);
      } else if (type === 'tools') {
        newMsgs[idx] = { ...newMsgs[idx], toolCalls: [] };
        if (!newMsgs[idx].content && (!newMsgs[idx].thinking || newMsgs[idx].thinking.trim() === '')) newMsgs.splice(idx, 1);
      }
      return newMsgs;
    });
    if (editingBlock?.id === id) {
      setEditingBlock(null);
    }
  };

  const handleRegenerate = async (id: string, type: 'user' | 'thinking' | 'response' | 'tools') => {
    const targetModel = currentModel || lastUsedModel;
    if (!targetModel) return;
    // Regeneration restarts the delegation cycle — clear the old task tree.
    taskListStore.reset();
    setDelegation(null);
    const msgIdx = messages.findIndex(m => m.id === id);
    if (msgIdx === -1) return;
    const msg = messages[msgIdx];

    if (type === 'user' || type === 'thinking') {
      const contextMsgs = messages.slice(0, msgIdx);
      setMessages(contextMsgs);

      // Regenerating a user prompt re-runs the full pipeline from that point.
      if (type === 'user') {
        const newMsgs = [...contextMsgs, { ...msg }];
        setMessages(newMsgs);
        runConversationTurn(newMsgs as ChatMessage[], targetModel);
      } else {
        // 'thinking' → the msgIdx points at the assistant message; re-stream it.
        streamAssistantTurn(contextMsgs, targetModel, 'draft');
      }
    } else if (type === 'response') {
      const contextMsgs = messages.slice(0, msgIdx);
      setMessages(contextMsgs);
      streamAssistantTurn(contextMsgs, targetModel, 'draft');
    } else if (type === 'tools') {
      // Legacy block type — treated as a plain response regeneration now.
      const contextMsgs = messages.slice(0, msgIdx);
      setMessages(contextMsgs);
      streamAssistantTurn(contextMsgs, targetModel, 'draft');
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
  // Order: user msg → thinking → tools block → response (per message), messages in array order
  // Nested chats feed the exact same pipeline — they just swap the source.
  const feedMessages = viewingNested ? nestedMessages : messages;
  const activityFeed = React.useMemo(() => {
    const activities: any[] = [];

    feedMessages.forEach((msg, msgIdx) => {
      if (msg.role === 'user') {
        activities.push({ type: 'user', messageId: msg.id, messageIdx: msgIdx, data: msg });
      } else if (msg.role === 'assistant') {
        const tcs = msg.toolCalls || [];
        // Show the thinking container from the moment generation starts —
        // waiting for the first thinking chunk left a dead gap (and sometimes
        // no container at all) when a tool call was flagged early.
        if (msg.thinking || (msg.isGenerating && !msg.content)) {
          const isLivePart = !!msg.isGenerating && !msg.isCallingTool && !msg.content;
          activities.push({ type: 'thinking', messageId: msg.id, messageIdx: msgIdx, partIdx: 0, text: msg.thinking || '', live: isLivePart, data: msg });
        }
        // Tools block (unified) — only if there are tool calls
        if (tcs.length > 0) {
          const hasBrowserCall = tcs.some((tc: any) => String(tc.name || tc.toolName || '').startsWith('browser'));
          activities.push({ type: 'tools', messageId: msg.id, messageIdx: msgIdx, data: { toolCalls: tcs, isGenerating: msg.isGenerating, hasBrowserCall } });
        }
        // Response content
        if (msg.content || (msg.isGenerating && !msg.thinking && !tcs.length)) {
          activities.push({ type: 'response', messageId: msg.id, messageIdx: msgIdx, data: msg });
        }
      }
    });

    // The Live Browser "teleports": it renders inside the most recent tools
    // block that contains browser_* calls (single webview instance).
    const lastBrowserToolsMessageId = (() => {
      for (let i = activities.length - 1; i >= 0; i--) {
        const a = activities[i];
        if (a.type === 'tools' && a.data.hasBrowserCall) return a.messageId;
      }
      return null;
    })();

    return { activities, lastBrowserToolsMessageId };
  }, [feedMessages]);

  // One renderer for every feed block — nested chats pass isNested=true which
  // suppresses the per-block toolbars (edit/regenerate/delete are home-only).
  const StatusDot = ({ status }: { status: 'queued' | 'running' | 'retrying' | 'done' | 'error' }) => (
    <span className={`shrink-0 w-2.5 h-2.5 rounded-full ${
      status === 'done' ? 'bg-green-400/90'
      : status === 'running' ? 'border-2 border-accent border-t-transparent animate-spin'
      : status === 'retrying' ? 'bg-yellow-400/90 animate-pulse'
      : status === 'error' ? 'bg-red-500/80'
      : 'border-2 border-white/25'
    }`} />
  );

  const renderActivity = (activity: any, idx: number, isNested: boolean) => {
    if (activity.type === 'user') {
      const msg = activity.data;
      const isEditingUser = editingBlock?.id === msg.id && editingBlock?.type === 'user';
      return (
        <div key={`user-${activity.messageId}`} className="flex flex-col w-full text-gray-100 gap-2 group/msg relative shrink-0" style={{ order: idx * 2 }}>
          <div className="flex items-center justify-between font-semibold text-sm text-textSecondary">
            <span>You</span>
          </div>
          <div data-msg-id={msg.id} data-msg-type="user" className={`w-full group relative ${isEditingUser ? 'ring-2 ring-accent rounded-lg p-2 -m-2' : ''}`}>
            {!isNested && !isGenerating && !msg.isGenerating && (
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
          <div className="w-full group relative">
            {!isNested && !isGenerating && !msg.isGenerating && (
              <BlockToolbar
                onEdit={() => setEditingBlock({ id: msg.id, type: 'thinking' })}
                onRegenerate={() => handleRegenerate(msg.id, 'thinking')}
                onDelete={() => handleDelete(msg.id, 'thinking')}
              />
            )}
            <ThinkingBlock
              thinking={(isEditingThinking && editPreview) ? editPreview.text : (activity.text || '')}
              isGenerating={!!activity.live}
            />
          </div>
        </div>
      );
    }

    if (activity.type === 'tools') {
      const { isGenerating: msgIsGenerating } = activity.data;
      return (
        <div key={`tools-${activity.messageId}`} className="flex flex-col w-full text-gray-100 gap-2 group/msg relative shrink-0" style={{ order: idx * 2 }}>
          <UnifiedToolsBlock
            activity={activity}
            isGenerating={isGenerating}
            msgIsGenerating={isNested ? true : msgIsGenerating}
            activityFeed={activityFeed}
            isBrowserExpanded={isBrowserExpanded}
            setIsBrowserExpanded={setIsBrowserExpanded}
            handleUserKillBrowser={handleUserKillBrowser}
            browserSessionId={browserSessionId}
            {...(isNested ? {} : {
              onEdit: () => setEditingBlock({ id: activity.messageId, type: 'tools' }),
              onRegenerate: () => handleRegenerate(activity.messageId, 'tools'),
              onDelete: () => handleDelete(activity.messageId, 'tools')
            })}
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
            {!isNested && !isGenerating && !msg.isGenerating && (
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
  };

  return (
    <div className="flex-1 flex flex-col bg-surface relative rounded-lg overflow-hidden min-w-0 bevel-light">

      {/* Panel-level controls — top right */}
      <div className="absolute top-2 right-2 z-30 flex items-center gap-1 no-drag-region">
        {hasTranscript && (
          <button
            onClick={downloadTranscript}
            className="p-1.5 rounded-full text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
            title="Download debug transcript"
          >
            <Bug size={15} />
          </button>
        )}
        {onToggleSettings && (
          <button
            onClick={onToggleSettings}
            className="p-1.5 rounded-full text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
            title="Model parameters"
          >
            <Settings2 size={15} />
          </button>
        )}
      </div>

      {/* Main Content */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 flex flex-col items-center overflow-y-auto w-full relative">

        {viewingNested ? (
          <div className="chat-measure flex flex-col gap-4 py-6 px-4 sm:px-6 lg:px-8 text-sm xl:text-base w-full">
            {/* Nested chat header — chevron returns to the parent chat */}
            <div className="flex items-center gap-2 sticky top-0 z-10 bg-surface py-2">
              <button
                onClick={backToParentChat}
                className="p-1.5 rounded-full text-textSecondary hover:text-white hover:bg-white/10 transition-colors"
                title="Back to parent chat"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-medium text-white truncate">{nestedMeta?.title || 'Nested chat'}</span>
              {(() => {
                const agent = viewingAgentId ? getAgentsSnapshot([viewingAgentId])[0] : null;
                return (
                  <>
                    {agent?.model && <span className="text-[11px] font-mono text-textSecondary">{agent.model.provider}/{agent.model.id}</span>}
                    {agent && (
                      <span className={`ml-auto text-[11px] font-mono shrink-0 ${agent.status === 'running' || agent.status === 'queued' ? 'text-accentBright animate-pulse'
                          : agent.status === 'error' ? 'text-red-400'
                            : 'text-green-400'
                        }`}>
                        {agent.status}
                      </span>
                    )}
                  </>
                );
              })()}
            </div>
            {activityFeed.activities.map((activity, idx) => renderActivity(activity, idx, true))}
            {activityFeed.activities.length === 0 && (
              <div className="text-textSecondary text-sm italic">The agent hasn't produced any output yet…</div>
            )}
            <div ref={bottomRef} className="w-full shrink-0" />
          </div>
        ) : activityFeed.activities.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center w-full px-4 sm:px-6 lg:px-8">
            <div className="flex flex-col items-center chat-measure mt-10">
              <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-6">
                <img src="https://ollama.com/public/icon-64x64.png" alt="Ollama" className="w-10 h-10" onError={(e) => e.currentTarget.style.display = 'none'} />
              </div>
              <h1 className="text-3xl font-semibold text-gray-100 mb-12">How can I help you today?</h1>
            </div>
          </div>
        ) : (
          <div className="chat-measure flex flex-col gap-4 py-6 px-4 sm:px-6 lg:px-8 text-sm xl:text-base">
            {activityFeed.activities.map((activity, idx) => renderActivity(activity, idx, false))}

            {/* Delegation timeline — the app-driven execution of an approved plan */}
            {delegation && !viewingNested && (
              <div className="w-full group relative shrink-0" style={{ order: 999998 }}>
                <div className="w-full rounded-xl border border-white/10 bg-white/[0.03] backdrop-blur-md overflow-hidden">
                  <div className="px-3 py-2 text-xs text-textSecondary flex items-center justify-between border-b border-white/5">
                    <div className="flex items-center gap-2">
                      <Terminal size={14} className="text-gray-400" />
                      <span className="font-medium">Delegated {delegation.steps.length} agent{delegation.steps.length !== 1 ? 's' : ''}</span>
                    </div>
                    <span className="font-mono text-textSecondary/80">
                      {delegation.steps.filter(s => s.status === 'done').length}/{delegation.steps.length} done
                    </span>
                  </div>
                  <div className="p-2 flex flex-col gap-1 bg-black/20">
                    {delegation.steps.map((s, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          if (!s.agentId) return;
                          const chatId = chatStore.getChatIdForAgent(s.agentId);
                          if (chatId) openNestedChat(chatId);
                        }}
                        disabled={!s.agentId}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors ${s.agentId ? 'hover:bg-white/[0.06]' : ''}`}
                      >
                        <StatusDot status={s.status} />
                        <span className={`text-xs font-medium shrink-0 ${s.status === 'error' ? 'text-red-400' : s.status === 'done' ? 'text-green-400/90 line-through decoration-textSecondary/40' : 'text-gray-100'}`}>
                          {i + 1}. {s.title}
                        </span>
                        <span className="text-[10px] font-mono text-textSecondary/60 uppercase shrink-0">{s.preset}</span>
                        <span className="text-[11px] text-textSecondary truncate flex-1">{s.resultSummary || (s.status === 'running' ? 'working…' : '')}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div ref={bottomRef} className="w-full shrink-0" style={{ order: 999999 }} />
          </div>
        )}
      </div>

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
      <div className="w-full flex justify-center p-4 sm:px-6 lg:px-8 bg-gradient-to-t from-surface via-surface to-transparent pt-10">
        <div className="chat-measure">
          <ChatInput
            onSend={handleSendMessage}
            onStop={handleStop}
            disabled={isGenerating || !!viewingNested}
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
        </div>
      </div>
    </div>
  );
};

export default ChatArea;
