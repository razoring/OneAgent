// Shared navigation state for the agent-driven embedded browser.
// The webview itself may unmount/remount (e.g. when its tool call block
// collapses), but the current URL survives here so it restores in place.

type Listener = (url: string) => void;
type SnapshotListener = (img: string | null) => void;

let currentUrl = 'https://html.duckduckgo.com/';
const listeners = new Set<Listener>();
const snapshotListeners = new Set<SnapshotListener>();

// Set when the USER kills the browser from the Live Browser header. Consumed
// by the next browser_* tool call so the agent learns why its session died.
let userKilledBrowser = false;

// Grayscale snapshot captured at terminate time — displayed over the Live
// Browser slot until the next browser_* tool call resumes the session.
let terminatedSnapshot: string | null = null;

export const agentBrowserStore = {
  getUrl: () => currentUrl,
  navigate: (url: string) => {
    if (!url || currentUrl === url) return;
    currentUrl = url;
    listeners.forEach(l => l(url));
  },
  subscribe: (l: Listener) => {
    listeners.add(l);
    return () => { listeners.delete(l); };
  },
  markUserKilled: () => { userKilledBrowser = true; },
  consumeUserKill: () => {
    if (!userKilledBrowser) return false;
    userKilledBrowser = false;
    return true;
  },
  getTerminatedSnapshot: (): string | null => terminatedSnapshot,
  setTerminatedSnapshot: (img: string | null) => {
    terminatedSnapshot = img;
    snapshotListeners.forEach(l => l(img));
  },
  subscribeSnapshot: (l: SnapshotListener) => {
    snapshotListeners.add(l);
    return () => { snapshotListeners.delete(l); };
  },
};
