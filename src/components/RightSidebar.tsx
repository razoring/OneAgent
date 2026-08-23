import React, { useState, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { ModelSettings, getModelSettings, saveModelSettings } from '../utils/llm';
import { modelParamsStore } from '../utils/modelParamsStore';

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

// Right-hand settings sidebar hosting the Model Parameters controls
// (moved out of the chat input's drop-up menu).
const RightSidebar = ({ open }: { open: boolean }) => {
  const [modelSettings, setModelSettings] = useState<ModelSettings>(() => getModelSettings());
  const [estimatedTokens, setEstimatedTokens] = useState<{ system: number; history: number; prompt: number } | null>(modelParamsStore.get());

  useEffect(() => modelParamsStore.subscribe(setEstimatedTokens), []);

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

  return (
    <div className={`overflow-hidden transition-all duration-300 ease-in-out ${open ? 'w-[320px]' : 'w-0'}`}>
      <div className="w-[320px] h-full bg-background flex flex-col gap-4 p-4 overflow-y-auto text-textSecondary">
        <span className="menu-header">Model Parameters</span>

        {/* Context Usage Chart */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold text-white font-mono">
              {totalTokens.toLocaleString()}
            </span>
            <span className="text-xs text-textSecondary font-mono">
              of {contextLimit.toLocaleString()} tokens
            </span>
          </div>
          <div className="flex h-2 w-full rounded-full overflow-hidden bg-white/10">
            {usageSegments.map((seg) => (
              <div
                key={seg.key}
                className="h-full"
                style={{ width: `${(seg.tokens / contextLimit) * 100}%`, backgroundColor: seg.color }}
              />
            ))}
          </div>
          <div className="flex items-center justify-between text-xs text-textSecondary px-0.5">
            {usageSegments.map((seg) => (
              <span key={seg.key} className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: seg.color }} />
                {seg.label} {Math.round((seg.tokens / contextLimit) * 100)}%
              </span>
            ))}
          </div>
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

        {/* Tasks — sub-agent tasks, nestable (orchestrator → sub-agents).
            Static mockup, no functionality yet */}
        <div className="flex flex-col gap-2 mt-6 pt-5">
          <div className="flex items-center justify-between">
            <span className="menu-header">Tasks</span>
            <span className="text-[11px] font-mono text-textSecondary">1/4</span>
          </div>

          {/* Orchestrator task with nested children */}
          <div className="rounded-xl border border-white/5 bg-black/20 p-2.5">
            <button className="w-full flex items-center gap-2.5 text-left hover:bg-white/[0.04] rounded-lg -m-1 p-1 transition-colors group">
              <span className="w-4 h-4 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
              <div className="min-w-0 flex-1">
                <TaskTitle running text="Collect 10 contractor contacts from Toronto-area listing websites" className="text-sm text-white" />
                <div className="text-[11px] text-textSecondary/70 font-mono">gemma4:12b · running</div>
              </div>
              <ChevronRight size={14} className="rotate-90 text-textSecondary group-hover:text-white transition-colors shrink-0" />
            </button>

            {/* Nested children — indented with a guide rail */}
            <div className="mt-2 ml-[11px] pl-3 border-l border-white/10 flex flex-col gap-1.5">

              {/* Child: done */}
              <button className="rounded-lg bg-black/30 p-2 flex items-center gap-2 text-left hover:bg-white/[0.04] transition-colors group">
                <span className="w-3.5 h-3.5 shrink-0 rounded-full bg-accent/80 flex items-center justify-center">
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-textSecondary line-through truncate">Search Toronto contractors</div>
                  <div className="text-[10px] text-textSecondary/70 font-mono">gemma3:4b · 14.2s</div>
                </div>
                <ChevronRight size={12} className="text-textSecondary group-hover:text-white transition-colors shrink-0" />
              </button>

              {/* Child: running */}
              <button className="rounded-lg border border-accent/30 bg-white/[0.03] p-2 flex items-center gap-2 text-left transition-colors group">
                <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                <div className="min-w-0 flex-1">
                  <TaskTitle running text="Extract contact emails and phone numbers from the top-ranked contractor sites" className="text-xs text-white" />
                  <div className="text-[10px] text-textSecondary/70 font-mono">gemma3:4b · running</div>
                </div>
                <ChevronRight size={12} className="text-textSecondary group-hover:text-white transition-colors shrink-0" />
              </button>

              {/* Grandchild (depth 2): queued */}
              <div className="ml-[11px] pl-3 border-l border-white/10 flex flex-col gap-1.5">
                <div className="rounded-lg bg-black/30 p-2 flex items-center gap-2 opacity-70">
                  <span className="w-3 h-3 shrink-0 rounded-full border-2 border-white/25" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-textSecondary truncate">Visit kijiji.ca listings</div>
                    <div className="text-[10px] text-textSecondary/70 font-mono">gemma3:4b · queued</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Standalone leaf task */}
          <div className="rounded-xl border border-white/5 bg-black/20 p-2.5 flex items-center gap-2.5 opacity-70">
            <span className="w-4 h-4 shrink-0 rounded-full border-2 border-white/25" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-textSecondary truncate">Summarize findings</div>
              <div className="text-[11px] text-textSecondary/70 font-mono">gemma3:4b · queued</div>
            </div>
          </div>

          <button className="menu-item !py-1.5 justify-center text-xs text-textSecondary hover:text-white">
            View all tasks
          </button>
        </div>
      </div>
    </div>
  );
};

export default RightSidebar;




