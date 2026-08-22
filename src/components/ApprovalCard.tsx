import React from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';

export interface PendingApproval {
  id: string;
  toolName: string;
  summary: string;
  onDecision: (approved: boolean) => void;
}

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

interface ApprovalCardProps {
  approval: PendingApproval;
}

const ApprovalCard: React.FC<ApprovalCardProps> = ({ approval }) => {
  const label = APPROVAL_LABELS[approval.toolName] || `Allow ${approval.toolName}`;

  return (
    <div className="menu-panel rounded-xl w-80 shadow-2xl border border-white/10 overflow-hidden animate-[fadeIn_0.15s_ease-out]">
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-2">
        <span className="flex items-center justify-center w-7 h-7 rounded-full bg-amber-500/15 text-amber-400 shrink-0">
          <ShieldAlert size={15} />
        </span>
        <span className="text-sm font-medium text-white">{label}</span>
      </div>

      {approval.summary && (
        <pre className="mx-4 mb-1 px-3 py-2 rounded-lg bg-black/30 text-xs font-mono text-gray-200 whitespace-pre-wrap break-all max-h-28 overflow-y-auto select-text">
          {approval.summary}
        </pre>
      )}

      <div className="px-3 py-3 flex justify-end gap-2">
        <button
          onClick={() => approval.onDecision(false)}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium text-textSecondary hover:bg-white/10 hover:text-white transition-colors"
        >
          <X size={14} />
          Deny
        </button>
        <button
          onClick={() => approval.onDecision(true)}
          autoFocus
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accentHover transition-colors shadow-lg shadow-accent/20"
        >
          <Check size={14} />
          Approve
        </button>
      </div>
    </div>
  );
};

export default ApprovalCard;
