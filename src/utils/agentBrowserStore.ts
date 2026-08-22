// Shared navigation state for the agent-driven embedded browser.
// The webview itself may unmount/remount (e.g. when its tool call block
// collapses), but the current URL survives here so it restores in place.

type Listener = (url: string) => void;

let currentUrl = 'https://html.duckduckgo.com/';
const listeners = new Set<Listener>();

// Set when the USER kills the browser from the Live Browser header. Consumed
// by the next browser_* tool call so the agent learns why its session died.
let userKilledBrowser = false;

// Grayscale snapshot displayed after kill — agent restarts with browser_navigate.
let terminatedSnapshot: string | null = null;

export const agentBrowserStore = {
  getUrl: () => currentUrl,
  getTerminatedSnapshot: () => terminatedSnapshot,
  navigate: (url: string) => {
    if (!url || currentUrl === url) return;
    // Starting a fresh navigation — clear any terminated snapshot so the
    // live webview shows instead of the grayscale image.
    if (url !== 'about:blank') terminatedSnapshot = null;
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
  setTerminatedSnapshot: (img: string | null) => { terminatedSnapshot = img; },
};
