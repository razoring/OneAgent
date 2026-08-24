// Queue of inline user prompts (permission requests, agent questions).
// Enqueueing returns a promise that resolves with the chosen option label or
// the custom text the user typed — the calling tool handler awaits it, so the
// LLM literally cannot continue until the user responds.
//
// Prompts originating from a formal task flip that task's needsInput flag,
// surfacing an "[ACTION REQUIRED]" state in the sidebar until answered.

export interface UserPrompt {
  id: string;
  title: string;
  detail?: string;
  options: string[];
  kind: 'ask' | 'approval';
}

type QueuedPrompt = UserPrompt & { resolve: (response: string | null) => void; taskId?: string };

let queue: QueuedPrompt[] = [];
const listeners = new Set<(q: UserPrompt[]) => void>();

const emit = () => listeners.forEach(l => l(queue.map(({ resolve, taskId, ...p }) => p)));

export const userPromptStore = {
  get: (): UserPrompt[] => queue.map(({ resolve, taskId, ...p }) => p),
  subscribe: (l: (q: UserPrompt[]) => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },

  enqueue: (p: Omit<UserPrompt, 'id'>, taskId?: string): Promise<string | null> =>
    new Promise(resolve => {
      queue.push({ ...p, id: Math.random().toString(36).substring(7), resolve, taskId });
      if (taskId) {
        import('./taskListStore').then(m => m.taskListStore.update(taskId, { needsInput: true }));
      }
      emit();
    }),

  // Resolves the prompt at `index` with the given response (option label or
  // custom text) and removes it from the queue.
  answer: (index: number, response: string | null) => {
    const item = queue[index];
    if (!item) return;
    queue = queue.filter(q => q !== item);
    if (item.taskId) {
      // Lazy import avoided — taskListStore has no dependency back here.
      import('./taskListStore').then(m => m.taskListStore.update(item.taskId!, { needsInput: false }));
    }
    item.resolve(response);
    emit();
  },

  // Aborts/cancels — resolve everything unanswered with null.
  flush: () => {
    const old = queue;
    queue = [];
    old.forEach(item => {
      if (item.taskId) {
        import('./taskListStore').then(m => m.taskListStore.update(item.taskId!, { needsInput: false }));
      }
      item.resolve(null);
    });
    emit();
  }
};
