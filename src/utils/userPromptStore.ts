// Queue of inline user prompts (permission requests, agent questions).
// Enqueueing returns a promise that resolves with the chosen option label or
// the custom text the user typed — the calling tool handler awaits it, so the
// LLM literally cannot continue until the user responds.

export interface UserPrompt {
  id: string;
  title: string;
  detail?: string;
  options: string[];
  kind: 'ask' | 'approval';
}

type QueuedPrompt = UserPrompt & { resolve: (response: string | null) => void };

let queue: QueuedPrompt[] = [];
const listeners = new Set<(q: UserPrompt[]) => void>();

const emit = () => listeners.forEach(l => l(queue.map(({ resolve, ...p }) => p)));

export const userPromptStore = {
  get: (): UserPrompt[] => queue.map(({ resolve, ...p }) => p),
  subscribe: (l: (q: UserPrompt[]) => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },

  enqueue: (p: Omit<UserPrompt, 'id'>): Promise<string | null> =>
    new Promise(resolve => {
      queue.push({ ...p, id: Math.random().toString(36).substring(7), resolve });
      emit();
    }),

  // Resolves the prompt at `index` with the given response (option label or
  // custom text) and removes it from the queue.
  answer: (index: number, response: string | null) => {
    const item = queue[index];
    if (!item) return;
    queue = queue.filter(q => q !== item);
    item.resolve(response);
    emit();
  },

  // Aborts/cancels — resolve everything unanswered with null.
  flush: () => {
    const old = queue;
    queue = [];
    old.forEach(item => item.resolve(null));
    emit();
  }
};
