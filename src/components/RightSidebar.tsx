import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { ModelSettings, getModelSettings, saveModelSettings } from '../utils/llm';
import { modelParamsStore } from '../utils/modelParamsStore';
import { taskListStore, TaskNode } from '../utils/taskListStore';

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

// ─── Donut chart ─────────────────────────────────────────────────────────────

const fmtBytes = (bytes: number): string => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
};

// SVG donut + column legend. Arcs are proportional to their share of `total`;
// when pctBase is set (e.g. the context window) percentages and any remainder
// ring are measured against that larger base instead of the segment sum.
const DonutBreakdown = ({ title, segments, total, centerTop, centerBottom, pctBase, hidePctFor }: {
  title: string;
  segments: { key: string; label: string; value: number; color: string }[];
  total: number;
  centerTop: string;
  centerBottom: string;
  pctBase?: number;
  hidePctFor?: string;
}) => {
  const size = 76;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const base = pctBase ?? total;

  let offset = 0;
  const arcs = segments.map(seg => {
    const frac = base > 0 ? Math.min(1, seg.value / base) : 0;
    const arc = { ...seg, dash: frac * c, gap: c - frac * c, offset };
    offset += frac * c;
    return arc;
  });

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-2">
      <span className="menu-header !text-[10px]">{title}</span>
      <div className="flex items-center gap-3">
        <div className="relative shrink-0" style={{ width: size, height: size }}>
          <svg width={size} height={size} className="-rotate-90">
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
            {arcs.filter(a => a.dash > 0).map(a => (
              <circle
                key={a.key}
                cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={a.color} strokeWidth={stroke}
                strokeDasharray={`${Math.max(0, a.dash - 1)} ${a.gap + 1}`}
                strokeDashoffset={-a.offset}
              />
            ))}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[11px] font-semibold text-white font-mono leading-none">{centerTop}</span>
            <span className="text-[9px] text-textSecondary font-mono mt-0.5">{centerBottom}</span>
          </div>
        </div>
        <div className="flex-1 min-w-0 grid grid-cols-1 gap-1 text-[10px] text-textSecondary">
          {segments.length > 0 ? segments.map(seg => (
            <div key={seg.key} className="grid grid-cols-[auto_1fr_auto] items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: seg.color }} />
              <span className="truncate" title={seg.label}>{seg.label}</span>
              <span className="font-mono tabular-nums">{hidePctFor === seg.key ? fmtBytes(seg.value) : base > 0 ? `${Math.round((seg.value / base) * 100)}%` : '0%'}</span>
            </div>
          )) : (
            <span className="font-mono text-textSecondary/60">No models resident</span>
          )}
        </div>
      </div>
    </div>
  );
};

// Right-hand settings sidebar hosting the Model Parameters controls

// Right-hand settings sidebar hosting the Model Parameters controls
// (moved out of the chat input's drop-up menu).
const RightSidebar = ({ open }: { open: boolean }) => {
  const [modelSettings, setModelSettings] = useState<ModelSettings>(() => getModelSettings());
  const [estimatedTokens, setEstimatedTokens] = useState<{ system: number; history: number; prompt: number } | null>(modelParamsStore.get());
  const [tasks, setTasks] = useState<TaskNode[]>(taskListStore.get());

  useEffect(() => modelParamsStore.subscribe(setEstimatedTokens), []);
  useEffect(() => taskListStore.subscribe(setTasks), []);

  // Only count/update tokens while this sidebar is open.
  useEffect(() => {
    modelParamsStore.setActive(open);
    return () => modelParamsStore.setActive(false);
  }, [open]);

  const updateSettings = (partial: Partial<ModelSettings>) => {
    const updated = { ...modelSettings, ...partial };
    setModelSettings(updated);
    saveModelSettings(updated);
  };

  const contextLimit = modelSettings.contextWindow || 8192;
  const usageSegments = [
    { key: 'prompt', label: 'Prompt', tokens: estimatedTokens?.prompt ?? 0, color: 'color-mix(in srgb, rgb(var(--accent-rgb)) 45%, white)' },
    { key: 'history', label: 'History', tokens: estimatedTokens?.history ?? 0, color: 'color-mix(in srgb, rgb(var(--accent-rgb)) 70%, white)' },
    { key: 'system', label: 'System', tokens: estimatedTokens?.system ?? 0, color: 'rgb(var(--accent-rgb))' },
  ];
  const totalTokens = (estimatedTokens?.system ?? 0) + (estimatedTokens?.history ?? 0) + (estimatedTokens?.prompt ?? 0);

  // Live VRAM monitor (total system usage) — only polls while this panel is open.
  const [vram, setVram] = useState<{ usedBytes: number; totalBytes: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await (window as any).electronAPI?.vramUsage?.();
        if (!cancelled) setVram(res?.success ? { usedBytes: res.usedBytes, totalBytes: res.totalBytes } : null);
      } catch {
        if (!cancelled) setVram(null);
      }
    };
    poll();
    const t = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [open]);

  return (
    <div className={`overflow-hidden transition-all duration-300 ease-in-out ${open ? 'w-[400px]' : 'w-0'}`}>
      <div className="w-[400px] h-full bg-background flex flex-col gap-4 p-4 overflow-y-auto text-textSecondary">
        <span className="menu-header">Model Parameters</span>

        {/* Context Usage + VRAM — side-by-side donut breakdowns */}
        <div className="flex items-start gap-3">
          <DonutBreakdown
            title="Context"
            segments={usageSegments.map(s => ({ key: s.key, label: s.label, value: s.tokens, color: s.color }))}
            total={contextLimit}
            centerTop={totalTokens.toLocaleString()}
            centerBottom="tokens"
            pctBase={contextLimit}
          />
          <DonutBreakdown
            title="VRAM"
            segments={vram ? [
              { key: 'used', label: 'Used', value: vram.usedBytes, color: 'rgb(var(--accent-rgb))' },
              { key: 'free', label: 'Free', value: Math.max(0, vram.totalBytes - vram.usedBytes), color: 'rgba(255,255,255,0.12)' },
            ] : []}
            total={vram?.totalBytes ?? 0}
            centerTop={vram ? fmtBytes(vram.usedBytes) : '—'}
            centerBottom={vram ? `/ ${fmtBytes(vram.totalBytes)}` : 'no GPU data'}
            pctBase={vram?.totalBytes}
            hidePctFor="free"
          />
        </div>

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
          {/* Slider is inverted so "No timeout" sits at the right end */}
          <input
            type="range"
            min={0}
            max={300}
            step={10}
            value={300 - modelSettings.thinkingTimeout}
            onChange={(e) => updateSettings({ thinkingTimeout: 300 - Number(e.target.value) })}
            className="neutral-slider w-full cursor-pointer"
            style={{ '--fill': `${((300 - modelSettings.thinkingTimeout) / 300) * 100}%` } as React.CSSProperties}
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

        {tasks.length > 0 && (
          <TasksSection tasks={tasks} />
        )}
      </div>
    </div>
  );
};

// ─── Tasks section ───────────────────────────────────────────────────────────

const fmtDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
};

const StatusRing = ({ status, size }: { status: TaskNode['status'], size: number }) => {
  const cls = `shrink-0 rounded-full flex items-center justify-center ${
    status === 'done' ? 'bg-accent/80'
    : status === 'running' ? 'border-2 border-accent border-t-transparent animate-spin'
    : status === 'error' ? 'bg-red-500/80'
    : 'border-2 border-white/25'
  }`;
  return (
    <span className={cls} style={{ width: size, height: size }}>
      {status === 'done' && (
        <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      )}
    </span>
  );
};

// One task row (or subtree). Running + overflowing titles marquee-scroll;
// anything else truncates. needsInput prefixes "[ACTION REQUIRED]".
const TaskRow = ({ node, depth, onInspect }: { node: TaskNode, depth: number, onInspect: (agentId: string) => void }) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (node.status !== 'running') return;
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [node.status]);

  const children = taskListStore.get().filter(n => n.parentId === node.id);
  const elapsed = node.status === 'running' && node.startedAt
    ? fmtDuration(Date.now() - node.startedAt)
    : node.status !== 'queued' && node.startedAt && node.endedAt
      ? fmtDuration(node.endedAt - node.startedAt)
      : undefined;

  const meta = node.needsInput
    ? 'waiting for your response'
    : [node.modelLabel, elapsed].filter(Boolean).join(' · ');

  const titleEl = <TaskTitle running={node.status === 'running'} text={(node.needsInput ? '[ACTION REQUIRED] ' : '') + node.title} className={`${depth === 0 ? 'text-sm' : 'text-xs'} ${node.status === 'done' ? 'line-through text-textSecondary' : node.status === 'running' ? 'text-white' : 'text-textSecondary'}`} />;

  return (
    <div>
      <button
        onClick={() => { if (node.agentId) onInspect(node.agentId); }}
        disabled={!node.agentId}
        className={`w-full rounded-lg p-2 flex items-center gap-2 text-left transition-colors group ${
          node.needsInput ? 'border border-accent/30 bg-white/[0.04]'
          : node.agentId ? 'bg-black/30 hover:bg-white/[0.05]'
          : 'bg-black/30 opacity-80'
        }`}
        style={{ marginLeft: depth * 12 }}
      >
        <StatusRing status={node.status} size={depth === 0 ? 16 : 14} />
        <div className="min-w-0 flex-1">
          {titleEl}
          {(meta || node.resultSummary) && (
            <div className="text-[10px] text-textSecondary/70 font-mono truncate">
              {[meta, node.resultSummary && !node.needsInput ? node.resultSummary : undefined].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
        {node.agentId && (
          <ChevronRight size={12} className="text-textSecondary group-hover:text-white transition-colors shrink-0" />
        )}
      </button>
      {children.length > 0 && (
        <div className="mt-1.5 ml-[11px] pl-3 border-l border-white/10 flex flex-col gap-1.5">
          {children.map(c => <TaskRow key={c.id} node={c} depth={depth + 1} onInspect={onInspect} />)}
        </div>
      )}
    </div>
  );
};

const TasksSection = ({ tasks }: { tasks: TaskNode[] }) => {
  const progress = taskListStore.leafProgress();
  const actionNeeded = tasks.filter(t => t.needsInput).length;
  const roots = tasks.filter(n => !n.parentId);

  return (
    <div className="flex flex-col gap-2 mt-6 pt-5">
      <div className="flex items-center justify-between">
        <span className="menu-header">Tasks</span>
        <span className={`text-[11px] font-mono ${actionNeeded > 0 ? 'text-accentBright animate-pulse' : 'text-textSecondary'}`}>
          {actionNeeded > 0 ? `${actionNeeded} action required` : `${progress.done}/${progress.total}`}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {roots.map(n => <TaskRow key={n.id} node={n} depth={0} onInspect={(agentId) => window.dispatchEvent(new CustomEvent('inspect-agent', { detail: agentId }))} />)}
      </div>
    </div>
  );
};


export default RightSidebar;

