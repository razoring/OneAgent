// Persistent per-chat task list — mirrors chatStore persistence pattern.
// Tasks live in <userData>/chats/<chatId>/messages.json -> ChatFile.tasks.
// Clear-before-add: task_add wipes existing tasks for the chat before inserting.
// LLM owns create/update via tools; user may only Clear-all via RightSidebar.
// Tasks are NOT injected into LLM history — LLM sees only active (queued/running) via task_list.

import { TaskNode, TaskStatus } from '../types/task';

const api = () => (window as any).electronAPI;

let tasksByChat = new Map<string, TaskNode[]>();
// in-memory listeners per chatId
const listeners = new Map<string, Set<(t: TaskNode[]) => void>>();
const globalListeners = new Set<(m: Map<string, TaskNode[]>) => void>();

const emit = (chatId: string) => {
  const list = tasksByChat.get(chatId) || [];
  listeners.get(chatId)?.forEach(l => l([...list]));
  globalListeners.forEach(l => l(new Map(tasksByChat)));
};

// ─── Debounced persistence (per chat) ───────────────────────────────────────
const DEBOUNCE_MS = 700;
const MAX_WAIT_MS = 4000;
interface Pending { payload: TaskNode[]; timer: any; firstAt: number }
const pending = new Map<string, Pending>();

const doSave = async (chatId: string, tasks: TaskNode[]) => {
  try {
    await api().chatsSave(chatId, { tasks: [...tasks] });
  } catch (e) {
    console.error('[taskStore] save failed', chatId, e);
  }
};

const scheduleFlush = (chatId: string, entry: Pending) => {
  clearTimeout(entry.timer);
  const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - entry.firstAt));
  entry.timer = setTimeout(() => {
    pending.delete(chatId);
    void doSave(chatId, entry.payload);
  }, wait);
};

const queueSave = (chatId: string) => {
  if (!chatId) return;
  const tasks = tasksByChat.get(chatId) || [];
  const now = Date.now();
  const existing = pending.get(chatId);
  if (existing) {
    existing.payload = [...tasks];
    if (now - existing.firstAt >= MAX_WAIT_MS) {
      clearTimeout(existing.timer);
      pending.delete(chatId);
      void doSave(chatId, [...tasks]);
    } else {
      scheduleFlush(chatId, existing);
    }
    return;
  }
  const entry: Pending = { payload: [...tasks], timer: null as any, firstAt: now };
  pending.set(chatId, entry);
  scheduleFlush(chatId, entry);
};

// ─── Public API ─────────────────────────────────────────────────────────────

export const taskStore = {
  // Hydrate a single chat's tasks from disk (called on chat switch / init).
  hydrate(chatId: string, tasks: TaskNode[]) {
    const normalized = (tasks || []).map(t => ({ ...t, chatId }));
    tasksByChat.set(chatId, normalized);
    emit(chatId);
  },

  // For chatStore to clear in-memory when a chat is deleted.
  forget(chatId: string) {
    tasksByChat.delete(chatId);
    pending.delete(chatId);
    emit(chatId);
  },

  get(chatId: string): TaskNode[] {
    return [...(tasksByChat.get(chatId) || [])];
  },

  getAll(): Map<string, TaskNode[]> {
    return new Map(tasksByChat);
  },

  subscribe(chatId: string, l: (t: TaskNode[]) => void) {
    if (!listeners.has(chatId)) listeners.set(chatId, new Set());
    listeners.get(chatId)!.add(l);
    l([...(tasksByChat.get(chatId) || [])]);
    return () => listeners.get(chatId)?.delete(l);
  },

  subscribeGlobal(l: (m: Map<string, TaskNode[]>) => void) {
    globalListeners.add(l);
    l(new Map(tasksByChat));
    return () => globalListeners.delete(l);
  },

  // LLM path: task_add with clear-before-add (no hard limit, verbose validation done in toolExecutor).
  // Caller validates verbosity; this just replaces.
  replaceAll(chatId: string, items: Omit<TaskNode, 'id' | 'chatId' | 'status' | 'createdAt' | 'updatedAt'>[]): TaskNode[] {
    // Clear existing (no deleted event needed — emit will reflect replacement)
    pending.delete(chatId);
    const now = Date.now();
    const next: TaskNode[] = items.map((it, idx) => ({
      id: `task-${Date.now().toString(36)}-${idx.toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      chatId,
      title: String(it.title).trim().slice(0, 120),
      description: String(it.description).trim(),
      goal: String(it.goal || '').trim(),
      assumptions: Array.isArray(it.assumptions) ? it.assumptions.map(String) : [],
      acceptanceCriteria: Array.isArray(it.acceptanceCriteria) ? it.acceptanceCriteria.map(String) : [],
      toolHint: (it.toolHint as TaskNode['toolHint']) || 'mixed',
      context: String(it.context || '').trim(),
      dependsOn: Array.isArray(it.dependsOn) ? it.dependsOn.map(String) : [],
      status: 'queued' as TaskStatus,
      createdAt: now,
      updatedAt: now,
    }));
    tasksByChat.set(chatId, next);
    tasksByChat.set(chatId, next);
    emit(chatId);
    queueSave(chatId);
    return [...next];
  },

  add(chatId: string, item: Omit<TaskNode, 'id' | 'chatId' | 'status' | 'createdAt' | 'updatedAt'>): TaskNode {
    const list = tasksByChat.get(chatId) || [];
    const now = Date.now();
    const task: TaskNode = {
      id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      chatId,
      title: String(item.title).trim().slice(0, 120),
      description: String(item.description).trim(),
      goal: String(item.goal || '').trim(),
      assumptions: Array.isArray(item.assumptions) ? item.assumptions.map(String) : [],
      acceptanceCriteria: Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.map(String) : [],
      toolHint: (item.toolHint as TaskNode['toolHint']) || 'mixed',
      context: String(item.context || '').trim(),
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : [],
      status: 'queued' as TaskStatus,
      createdAt: now,
      updatedAt: now,
      agentId: item.agentId
    };
    list.push(task);
    tasksByChat.set(chatId, list);
    emit(chatId);
    queueSave(chatId);
    return task;
  },

  update(chatId: string, id: string, updates: Partial<TaskNode>): TaskNode | null {
    const list = tasksByChat.get(chatId);
    if (!list) return null;
    const i = list.findIndex(t => t.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...updates, updatedAt: Date.now() };
    if (updates.status === 'done' || updates.status === 'error') {
      list[i].completedAt = list[i].completedAt || Date.now();
    }
    queueSave(chatId);
    emit(chatId);
    return list[i];
  },

  updateByAgent(chatId: string, agentId: string, updates: Partial<TaskNode>): TaskNode | null {
    const list = tasksByChat.get(chatId);
    if (!list) return null;
    const i = list.findIndex(t => t.agentId === agentId);
    if (i < 0) return null;
    list[i] = { ...list[i], ...updates, updatedAt: Date.now() };
    if (updates.status === 'done' || updates.status === 'error') {
      list[i].completedAt = list[i].completedAt || Date.now();
    }
    queueSave(chatId);
    emit(chatId);
    return list[i];
  },

  // User path: Clear all for a chat (RightSidebar button). LLM never calls this.
  clear(chatId: string) {
    if (!chatId) return;
    pending.delete(chatId);
    tasksByChat.set(chatId, []);
    emit(chatId);
    queueSave(chatId);
  },

  // For LLM tool: list only active (queued/running) — hides old done/error to avoid context bleed.
  listActive(chatId: string): TaskNode[] {
    const list = tasksByChat.get(chatId) || [];
    return list.filter(t => t.status === 'queued' || t.status === 'running');
  },

  // For UI: full list including done/error (persistent view until user clears).
  listAllForChat(chatId: string): TaskNode[] {
    return [...(tasksByChat.get(chatId) || [])];
  },

  flushSaves() {
    for (const [chatId, entry] of [...pending.entries()]) {
      clearTimeout(entry.timer);
      pending.delete(chatId);
      void doSave(chatId, entry.payload);
    }
  },

  // On chat delete, called by chatStore.
  onChatDeleted(chatId: string) {
    tasksByChat.delete(chatId);
    pending.delete(chatId);
    listeners.delete(chatId);
    globalListeners.forEach(l => l(new Map(tasksByChat)));
  }
};
