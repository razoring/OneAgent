// Live token-usage estimate shared from the chat input to the right sidebar.
// Computing is gated by `active` so nothing counts while the sidebar is closed.
type TokenStats = { system: number; history: number; prompt: number } | null;

let stats: TokenStats = null;
let active = false;
let recompute: (() => void) | null = null;
const listeners = new Set<(s: TokenStats) => void>();

export const modelParamsStore = {
  get: (): TokenStats => stats,
  isActive: (): boolean => active,
  // Called by the chat input to register its compute function.
  setRecompute: (fn: (() => void) | null) => { recompute = fn; },
  // Called by the right sidebar when it opens/closes.
  setActive: (a: boolean) => {
    if (active === a) return;
    active = a;
    if (a) recompute?.();
    else { stats = null; listeners.forEach(l => l(stats)); }
  },
  publish: (s: TokenStats) => { stats = s; listeners.forEach(l => l(s)); },
  subscribe: (l: (s: TokenStats) => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  }
};
