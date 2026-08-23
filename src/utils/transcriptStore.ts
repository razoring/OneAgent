// Transcript of the most recent assistant response, for the titlebar copy button.
let lastTranscript = '';
const listeners = new Set<(t: string) => void>();

export const transcriptStore = {
  set: (t: string) => {
    if (!t || t === lastTranscript) return;
    lastTranscript = t;
    listeners.forEach(l => l(t));
  },
  get: () => lastTranscript,
  subscribe: (l: (t: string) => void) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  }
};
