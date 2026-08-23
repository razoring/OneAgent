import React, { useState, useEffect } from 'react';
import { ModelSettings, getModelSettings, saveModelSettings } from '../utils/llm';
import { modelParamsStore } from '../utils/modelParamsStore';

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
      </div>
    </div>
  );
};

export default RightSidebar;
