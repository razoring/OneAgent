import React, { useState, useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { ModelSettings, getModelSettings, saveModelSettings, getProviderStatus } from '../utils/llm';
import { modelParamsStore } from '../utils/modelParamsStore';
import { taskStore } from '../utils/taskStore';
import { chatStore } from '../utils/chatStore';
import { TaskNode } from '../types/task';

const PieChart = ({ data, total, size = 64, thickness = 10 }: { data: { value: number, color: string }[], total: number, size?: number, thickness?: number }) => {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="transform -rotate-90">
      <circle cx={size/2} cy={size/2} r={r} fill="transparent" stroke="rgba(255,255,255,0.05)" strokeWidth={thickness} />
      {data.map((d, i) => {
        if (d.value <= 0) return null;
        const pct = total > 0 ? d.value / total : 0;
        const dash = pct * c;
        const gap = c - dash;
        const currentOffset = offset;
        offset += dash;
        return (
          <circle
            key={i} cx={size/2} cy={size/2} r={r} fill="transparent"
            stroke={d.color} strokeWidth={thickness}
            strokeDasharray={`${dash} ${gap}`}
            strokeDashoffset={-currentOffset}
          />
        );
      })}
    </svg>
  );
};

// Task title: truncates normally; running tasks whose text overflows get a
// slow edge-faded marquee driven by rAF (exact end-to-end travel, no overshoot).
const TaskTitle = ({ text, running, className }: { text: string, running?: boolean, className?: string }) => {
  const clipRef = useRef<HTMLDivElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [dist, setDist] = useState(0);

  const measure = () => {
    const c = clipRef.current;
    const s = spanRef.current;
    if (c && s) setDist(Math.max(0, s.scrollWidth - c.clientWidth));
  };

  useEffect(() => {
    if (!running) { setDist(0); return; }
    measure();
    const ro = new ResizeObserver(measure);
    if (clipRef.current) ro.observe(clipRef.current);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [running, text]);

  const scrolling = !!running && dist > 2;

  // rAF marquee: ping-pong 0 ↔ -dist with sine easing and pauses at both ends.
  useEffect(() => {
    if (!scrolling) {
      if (spanRef.current) spanRef.current.style.transform = '';
      return;
    }
    let raf = 0;
    const speed = 24; // px per second
    const pauseAtEnds = 1.4; // seconds held at each side
    const travelTime = dist / speed;
    const halfCycle = travelTime + pauseAtEnds;
    let start: number | null = null;
    const step = (t: number) => {
      if (start === null) start = t;
      const cycle = halfCycle * 2;
      const phase = ((t - start) / 1000) % cycle;
      let p: number;
      if (phase < halfCycle) {
        const u = Math.min(1, Math.max(0, (phase - pauseAtEnds / 2) / travelTime));
        p = (1 - Math.cos(Math.PI * u)) / 2; // ease-in-out
      } else {
        const u = Math.min(1, Math.max(0, (phase - halfCycle - pauseAtEnds / 2) / travelTime));
        p = 1 - (1 - Math.cos(Math.PI * u)) / 2;
      }
      if (spanRef.current) spanRef.current.style.transform = `translateX(${(-dist * p).toFixed(2)}px)`;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [scrolling, dist]);

  return (
    <div ref={clipRef} className={`${scrolling ? 'task-title-scroll' : 'truncate'} ${className || ''}`}>
      <span ref={spanRef} style={{ display: scrolling ? 'inline-block' : undefined }}>{text}</span>
    </div>
  );
};

// ─── Tasks helpers (read-only, LLM-owned) ────────────────────────────────────

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); const rs = s % 60;
  return `${m}m ${rs}s`;
};

const StatusRing = ({ status, size }: { status: TaskNode['status']; size: number }) => {
  const cls = `shrink-0 rounded-full flex items-center justify-center ${
    status === 'done' ? 'bg-accent/80'
      : status === 'running' ? 'border-2 border-accent border-t-transparent animate-spin'
      : status === 'error' ? 'bg-red-500/80'
      : 'border-2 border-white/25'
  }`;
  const dim = `${size}px`;
  return (
    <span className={cls} style={{ width: dim, height: dim }}>
      {status === 'done' && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
      {status === 'error' && <span className="text-white text-[8px] font-bold">×</span>}
    </span>
  );
};

const TaskRow = ({ node }: { node: TaskNode }) => {
  const [expanded, setExpanded] = useState(false);
  const running = node.status === 'running';
  const done = node.status === 'done';
  const elapsed = node.completedAt ? fmtDuration(node.completedAt - node.createdAt) : node.status === 'running' ? fmtDuration(Date.now() - node.createdAt) : null;
  const meta = [node.toolHint, elapsed].filter(Boolean).join(' · ');
  return (
    <div className={`rounded-xl border ${done ? 'border-white/5 bg-black/20 opacity-70' : running ? 'border-accent/30 bg-white/[0.03]' : 'border-white/5 bg-black/20'} p-2.5 flex flex-col gap-1.5`}>
      <div className="flex items-center gap-2.5">
        <StatusRing status={node.status} size={done ? 14 : 16} />
        <div className="min-w-0 flex-1">
          <TaskTitle running={running} text={node.title} className={`text-sm ${done ? 'line-through text-textSecondary' : running ? 'text-white' : 'text-textSecondary'}`} />
          {(meta || node.resultSummary) && (
            <div className="text-[11px] text-textSecondary/70 font-mono truncate">
              {node.resultSummary ? node.resultSummary : meta}
              {node.resultSummary && meta ? ` · ${meta}` : ''}
            </div>
          )}
        </div>
        {(node.context || node.acceptanceCriteria?.length > 0) && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="shrink-0 p-1 rounded hover:bg-white/10 text-textSecondary hover:text-white transition-colors"
            title={expanded ? 'Collapse details' : 'Expand details'}
          >
            <span className={`block transition-transform ${expanded ? 'rotate-90' : ''} text-xs`}>›</span>
          </button>
        )}
      </div>
      <div className="text-xs text-textSecondary/80 leading-relaxed line-clamp-2">{node.description}</div>
      {expanded && (
        <div className="mt-1 flex flex-col gap-1.5 pt-2 border-t border-white/5">
          {node.goal && <div className="text-xs text-textSecondary"><span className="font-medium text-white/80">Goal:</span> {node.goal}</div>}
          {node.context && <div className="text-[11px] font-mono bg-black/30 rounded-lg p-2 border border-white/5 whitespace-pre-wrap break-all">{node.context}</div>}
          {node.acceptanceCriteria?.length > 0 && (
            <div className="text-xs">
              <div className="font-medium text-white/80 mb-1">Acceptance</div>
              <ul className="space-y-0.5">
                {node.acceptanceCriteria.map((c, i) => (
                  <li key={i} className="flex gap-1.5 text-textSecondary/80">
                    <span className={`mt-0.5 shrink-0 w-3 h-3 rounded border flex items-center justify-center ${done ? 'bg-accent/80 border-accent/80' : 'border-white/20'}`}>
                      {done && <svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>}
                    </span>
                    <span className={done ? 'line-through' : ''}>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {node.assumptions?.length > 0 && <div className="text-[11px] text-textSecondary/60">Assumptions: {node.assumptions.join(' · ')}</div>}
        </div>
      )}
    </div>
  );
};

const TasksSection = ({ open }: { open: boolean }) => {
  const [activeChatId, setActiveChatId] = useState<string | null>(() => chatStore.getActiveId());
  const [tasks, setTasks] = useState<TaskNode[]>(() => (activeChatId ? taskStore.listAllForChat(activeChatId) : []));

  useEffect(() => {
    const unsubActive = chatStore.subscribeActive((id) => {
      setActiveChatId(id);
      setTasks(id ? taskStore.listAllForChat(id) : []);
    });
    return () => unsubActive();
  }, []);

  useEffect(() => {
    if (!activeChatId) return;
    const unsub = taskStore.subscribe(activeChatId, (newTasks) => {
      setTasks(prev => {
        if (prev.length === newTasks.length && prev.every((t, i) => t.id === newTasks[i].id && t.status === newTasks[i].status && t.updatedAt === newTasks[i].updatedAt)) {
          return prev;
        }
        return newTasks;
      });
    });
    return () => unsub();
  }, [activeChatId]);

  // Keep token estimation active etc. not needed here.
  useEffect(() => {
    if (!open) return;
    // No-op: ensures RightSidebar open prop doesn't affect task persistence.
  }, [open]);

  const done = tasks.filter(t => t.status === 'done').length;
  const total = tasks.length;

  return (
    <div className="flex flex-col gap-2 mt-6 pt-5">
      <div className="flex items-center justify-between">
        <span className="menu-header">Tasks</span>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-textSecondary">{total === 0 ? '—' : `${done}/${total}`}</span>
          <button
            onClick={() => activeChatId && taskStore.clear(activeChatId)}
            disabled={total === 0}
            className="p-1 rounded text-textSecondary/70 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="Clear all tasks for this chat (user-only, not fed to LLM)"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>
      {total === 0 ? (
        <div className="rounded-xl border border-white/5 bg-black/20 p-3 text-xs text-textSecondary/70 leading-relaxed">
          No tasks yet — LLM will populate after plan Proceed. Tasks are persistent per chat but only active (queued/running) are visible to the LLM via <span className="font-mono">task_list</span>.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {tasks.map(n => <TaskRow key={n.id} node={n} />)}
        </div>
      )}
    </div>
  );
};

// Right-hand settings sidebar hosting the Model Parameters controls
// (moved out of the chat input's drop-up menu).
const RightSidebar = ({ open }: { open: boolean }) => {
  const [modelSettings, setModelSettings] = useState<ModelSettings>(() => getModelSettings());
  const [estimatedTokens, setEstimatedTokens] = useState<{ system: number; history: number; prompt: number } | null>(modelParamsStore.get());
  const [providerStatus, setProviderStatus] = useState<Record<string, any>>({});

  useEffect(() => modelParamsStore.subscribe(setEstimatedTokens), []);

  // Only count/update tokens while this sidebar is open.
  useEffect(() => {
    modelParamsStore.setActive(open);
    return () => modelParamsStore.setActive(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const fetchStatus = () => getProviderStatus().then(setProviderStatus).catch(() => {});
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => { clearInterval(interval as any); };
  }, [open]);

  const updateSettings = (partial: Partial<ModelSettings>) => {
    const updated = { ...modelSettings, ...partial };
    setModelSettings(updated);
    saveModelSettings(updated);
  };

  const contextLimit = modelSettings.contextWindow || 8192;
  const usageSegments = [
    { key: 'prompt', label: 'Prompt', value: estimatedTokens?.prompt ?? 0, color: 'color-mix(in srgb, rgb(var(--accent-rgb)) 45%, white)' },
    { key: 'history', label: 'History', value: estimatedTokens?.history ?? 0, color: 'color-mix(in srgb, rgb(var(--accent-rgb)) 70%, white)' },
    { key: 'system', label: 'System', value: estimatedTokens?.system ?? 0, color: 'rgb(var(--accent-rgb))' },
  ];
  const totalTokens = (estimatedTokens?.system ?? 0) + (estimatedTokens?.history ?? 0) + (estimatedTokens?.prompt ?? 0);

  const ollamaStatus = providerStatus['ollama'];
  let vramUsed = 0;
  let vramModels = 0;
  if (ollamaStatus?.kind === 'vram') {
    vramUsed = ollamaStatus.models.reduce((acc: number, m: any) => acc + (m.vramBytes || 0), 0);
    vramModels = ollamaStatus.models.length;
  }

  return (
    <div className={`overflow-hidden transition-all duration-300 ease-in-out ${open ? 'w-[320px]' : 'w-0'}`}>
      <div className="w-[320px] h-full bg-background flex flex-col gap-4 p-4 overflow-y-auto text-textSecondary">
        <span className="menu-header">Hardware & Context</span>

        {/* Context & VRAM Charts */}
        <div className="flex gap-3 mb-2">
          {/* Context Pie */}
          <div className="flex-1 flex flex-col items-center gap-2 p-3 bg-black/20 border border-white/5 rounded-xl">
            <span className="text-[10px] font-semibold text-textSecondary uppercase tracking-wider">Context</span>
            <div className="relative">
              <PieChart data={usageSegments} total={contextLimit} size={72} thickness={8} />
              <div className="absolute inset-0 flex items-center justify-center flex-col">
                <span className="text-[11px] text-white/90 font-mono font-semibold">
                  {Math.round((totalTokens / contextLimit) * 100)}%
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-0.5 w-full mt-1">
              {usageSegments.map((seg) => (
                <div key={seg.key} className="flex items-center justify-between text-[9px] text-textSecondary px-0.5">
                  <span className="flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: seg.color }} />
                    {seg.label}
                  </span>
                  <span className="font-mono">{seg.value}</span>
                </div>
              ))}
            </div>
          </div>
          
          {/* VRAM Pie */}
          <div className="flex-1 flex flex-col items-center gap-2 p-3 bg-black/20 border border-white/5 rounded-xl opacity-90">
            <span className="text-[10px] font-semibold text-textSecondary uppercase tracking-wider">VRAM</span>
            <div className="relative">
              <PieChart 
                data={[{ value: vramUsed, color: 'rgb(var(--accent-rgb))' }]} 
                total={Math.max(vramUsed, 8 * 1024 * 1024 * 1024)} 
                size={72} thickness={8} 
              />
              <div className="absolute inset-0 flex items-center justify-center flex-col">
                <span className="text-[11px] text-white/90 font-mono font-semibold">
                  {vramModels}
                </span>
                <span className="text-[8px] text-textSecondary/60 font-mono">MDLS</span>
              </div>
            </div>
            <div className="flex flex-col justify-center items-center h-full w-full mt-1">
              <span className="text-[10px] text-textSecondary font-mono font-medium">
                {vramUsed > 0 ? `${(vramUsed / (1024*1024*1024)).toFixed(1)} GB` : '0 GB'}
              </span>
              <span className="text-[9px] text-textSecondary/50 font-mono">Used</span>
            </div>
          </div>
        </div>

        <span className="menu-header mt-2">Model Parameters</span>

        {/* Thinking Level */}
        <div className="flex flex-col gap-1.5">
          <div className="flex justify-between items-center text-sm">
            <span className="text-textSecondary font-medium">Thinking Level</span>
            <span className="text-textSecondary font-mono text-xs capitalize">{modelSettings.thinkingLevel}</span>
          </div>
          <div className="grid grid-cols-4 gap-1 p-1 bg-black/30 rounded-xl border border-white/5">
            {(['off', 'low', 'medium', 'high'] as const).map(level => (
              <button
                key={level}
                type="button"
                onClick={() => updateSettings({ thinkingLevel: level })}
                className={`py-1.5 text-sm rounded-lg capitalize transition-colors ${modelSettings.thinkingLevel === level
                    ? 'bg-white/20 text-white font-medium shadow-sm'
                    : 'text-textSecondary hover:text-gray-200'
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
            <span className="text-textSecondary font-medium">Thinking Timeout</span>
            <span className="text-textSecondary font-mono text-xs">
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
            <span className="text-textSecondary font-medium">Model Temperature</span>
            <span className="text-textSecondary font-mono text-xs">{modelSettings.temperature.toFixed(2)}</span>
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
            <span className="text-textSecondary font-medium">Top-P</span>
            <span className="text-textSecondary font-mono text-xs">{modelSettings.topP.toFixed(2)}</span>
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
            <span className="text-textSecondary font-medium">Max Output Length</span>
            <span className="text-textSecondary font-mono text-xs">
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
            <span className="text-textSecondary font-medium">Context Window</span>
            <span className="text-textSecondary font-mono text-xs">
              {contextLimit >= 1024 ? `${Math.round(contextLimit / 1024)}K` : contextLimit} tokens
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

        {/* Tasks — persistent per-chat, LLM-owned (clear-before-add), user Clear-all only */}
        <TasksSection open={open} />
      </div>
    </div>
  );
};

export default RightSidebar;




