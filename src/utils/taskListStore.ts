// Formal task tree for orchestrator-driven delegation. The orchestrator
// creates tasks after plan approval and binds sub-agents to them; this store
// mirrors their lifecycle for the sidebar UI. Session-only (in-memory).

export type TaskStatus = 'queued' | 'running' | 'done' | 'error';

export interface TaskNode {
  id: string;
  parentId: string | null;
  title: string;
  detail?: string;
  status: TaskStatus;
  // True while a bound agent has an unanswered ask_user prompt pending.
  needsInput?: boolean;
  agentId?: string;
  modelLabel?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  resultSummary?: string;
}

let nodes: Map<string, TaskNode> = new Map();
const listeners = new Set<(t: TaskNode[]) => void>();

const emit = () => {
  nodes = new Map(nodes); // fresh reference so memoized consumers re-render
  listeners.forEach(l => l(Array.from(nodes.values())));
};

const genId = () => 'task-' + Math.random().toString(36).substring(2, 9);

export const taskListStore = {
  get: (): TaskNode[] => Array.from(nodes.values()),

  subscribe: (l: (t: TaskNode[]) => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },

  add: (items: { title: string; detail?: string }[], parentId: string | null = null): TaskNode[] => {
    const created: TaskNode[] = [];
    for (const item of items) {
      if (!item.title || !String(item.title).trim()) continue;
      const node: TaskNode = {
        id: genId(),
        parentId,
        title: String(item.title).trim(),
        detail: item.detail ? String(item.detail) : undefined,
        status: 'queued',
        createdAt: Date.now()
      };
      nodes.set(node.id, node);
      created.push(node);
    }
    if (created.length > 0) emit();
    return created;
  },

  update: (id: string, patch: Partial<Omit<TaskNode, 'id' | 'parentId' | 'createdAt'>>) => {
    const node = nodes.get(id);
    if (!node) return;
    Object.assign(node, patch);
    emit();
  },

  find: (id: string): TaskNode | undefined => nodes.get(id),

  // Completed leaves / total leaves — drives the "1/4" header counter.
  leafProgress: (): { done: number; total: number } => {
    const all = Array.from(nodes.values());
    const parents = new Set(all.map(n => n.parentId).filter(Boolean));
    const leaves = all.filter(n => !parents.has(n.id));
    return {
      total: leaves.length,
      done: leaves.filter(n => n.status === 'done').length
    };
  },

  reset: () => { nodes = new Map(); emit(); }
};
