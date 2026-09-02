// Persistent per-chat verbose task model.
// LLM creates via task_add (clear-before-add), updates via task_update, reads via task_list.
// User can only Clear-all via RightSidebar; no per-task edit/delete.

export type TaskStatus = 'queued' | 'running' | 'done' | 'error';

export interface TaskNode {
  id: string;
  chatId: string;
  title: string;
  description: string;
  goal: string;
  assumptions: string[];
  acceptanceCriteria: string[];
  toolHint: 'files' | 'browser' | 'shell' | 'mixed' | 'none';
  context: string;
  dependsOn: string[];
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resultSummary?: string;
  agentId?: string;
}
