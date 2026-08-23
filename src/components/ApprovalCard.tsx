import React from 'react';
import { ShieldAlert, HelpCircle, ChevronLeft, ChevronRight } from 'lucide-react';
import type { UserPrompt } from '../utils/userPromptStore';

// Inline permission/question handler rendered inside the chat input panel.
// Replaces the normal input while active; the chat send button submits.
const InlineUserPrompt: React.FC<{
  prompt: UserPrompt;
  index: number;
  total: number;
  selectedIdx: number | null;   // null = custom response selected
  customSelected: boolean;
  onSelectOption: (i: number) => void;
  onToggleCustom: () => void;
  onPrev: () => void;
  onNext: () => void;
}> = ({ prompt, index, total, selectedIdx, customSelected, onSelectOption, onToggleCustom, onPrev, onNext }) => {
  const Icon = prompt.kind === 'approval' ? ShieldAlert : HelpCircle;

  return (
    <div className="rounded-2xl bg-white/[0.03] border border-white/10 overflow-hidden">
      <div className="p-3 flex flex-col gap-2.5">
        {/* Header with queue navigation */}
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-textSecondary shrink-0" />
          <span className="text-[13px] font-medium text-white truncate">{prompt.title}</span>
          <span className="flex-1" />
          <button
            onClick={onPrev}
            disabled={index === 0}
            className="p-0.5 text-textSecondary hover:text-white transition-colors disabled:opacity-30"
            title="Previous prompt"
          >
            <ChevronLeft size={13} />
          </button>
          <span className="text-[10px] font-mono text-textSecondary">{index + 1} of {total}</span>
          <button
            onClick={onNext}
            disabled={index >= total - 1}
            className="p-0.5 text-textSecondary hover:text-white transition-colors disabled:opacity-30"
            title="Next prompt"
          >
            <ChevronRight size={13} />
          </button>
        </div>

        {prompt.detail && (
          <pre className="px-3 py-2 rounded-lg bg-black/30 text-xs font-mono text-gray-200 whitespace-pre-wrap break-all max-h-28 overflow-y-auto select-text">
            {prompt.detail}
          </pre>
        )}

        {/* Choices — the model decides how many; custom is always available */}
        <div className="flex flex-col gap-1">
          {prompt.options.map((opt, i) => {
            const selected = !customSelected && selectedIdx === i;
            return (
              <button
                key={`${prompt.id}-${i}`}
                onClick={() => onSelectOption(i)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                  selected
                    ? 'bg-white/10 text-white'
                    : 'text-textSecondary hover:bg-white/5 hover:text-gray-200'
                }`}
              >
                <span className={`w-3.5 h-3.5 shrink-0 rounded-full border flex items-center justify-center ${
                  selected ? 'border-accent' : 'border-white/25'
                }`}>
                  {selected && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
                </span>
                {opt}
              </button>
            );
          })}

          {/* Custom answer — selecting reveals the main editor below */}
          <button
            onClick={onToggleCustom}
            className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-left transition-colors ${
              customSelected
                ? 'bg-white/10 text-white'
                : 'text-textSecondary hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            <span className={`w-3.5 h-3.5 shrink-0 rounded-full border flex items-center justify-center ${
              customSelected ? 'border-accent' : 'border-white/25'
            }`}>
              {customSelected && <span className="w-1.5 h-1.5 rounded-full bg-accent" />}
            </span>
            Write a custom response
          </button>
        </div>
      </div>
    </div>
  );
};

export default InlineUserPrompt;
