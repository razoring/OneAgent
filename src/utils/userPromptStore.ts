// Queue of inline user prompts (permission requests, agent questions).
// Enqueueing returns a promise that resolves with the chosen option label or
// the custom text the user typed — the calling tool handler awaits it, so the
// LLM literally cannot continue until the user responds.
//
// IDENTICAL PROMPTS ARE BATCHED: when several agents ask the same question
// (same kind + title + detail), they share ONE card; answering it resolves
// every waiter with the same response. This kills the pop-up-after-pop-up
// pattern where finishing one identical prompt immediately surfaces another.

export interface UserPrompt {
  id: string;
  title: string;
  detail?: string;
  options: string[];
  kind: 'ask' | 'approval';
}

interface QueuedPrompt extends UserPrompt {
  // Every awaiter that joined this card (identical duplicates included).
  resolvers: Array<(response: string | null) => void>;
  taskId?: string;
}

let queue: QueuedPrompt[] = [];
const listeners = new Set<(q: UserPrompt[]) => void>();

const emit = () => listeners.forEach(l => l(queue.map(({ resolvers, ...p }) => p)));

const normalize = (s: string | undefined) =>
  (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const groupKeyOf = (p: Omit<UserPrompt, 'id'>) =>
  `${p.kind}::${normalize(p.title)}::${normalize(p.detail)}`;

export const userPromptStore = {
  get: (): UserPrompt[] => queue.map(({ resolvers, ...p }) => p),
  subscribe: (l: (q: UserPrompt[]) => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },

  enqueue: (p: Omit<UserPrompt, 'id'>, taskId?: string): Promise<string | null> =>
    new Promise(resolve => {
      const key = groupKeyOf(p);
      const existing = queue.find(q => groupKeyOf(q) === key);
      if (existing) {
        // Identical prompt already on screen — join it instead of stacking
        // a duplicate card. One answer satisfies every waiter.
        existing.resolvers.push(resolve);
        if (taskId && taskId !== existing.taskId) {
          import('./taskListStore').then(m => m.taskListStore.update(taskId, { needsInput: true }));
        }
        return;
      }
      queue.push({
        ...p,
        id: Math.random().toString(36).substring(7),
        resolvers: [resolve],
        taskId
      });
      if (taskId) {
        import('./taskListStore').then(m => m.taskListStore.update(taskId, { needsInput: true }));
      }
      emit();
    }),

  // Resolves the prompt at `index` (and every identical prompt batched into
  // it) with the given response.
  answer: (index: number, response: string | null) => {
    const item = queue[index];
    if (!item) return;
    queue = queue.filter(q => q !== item);
    if (item.taskId) {
      import('./taskListStore').then(m => m.taskListStore.update(item.taskId!, { needsInput: false }));
    }
    item.resolvers.forEach(r => r(response));
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
      item.resolvers.forEach(r => r(null));
    });
    emit();
  }
};
