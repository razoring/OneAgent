// Shared navigation state for the agent-driven embedded browser.
// The webview itself may unmount/remount (e.g. when its tool call block
// collapses), but the current URL survives here so it restores in place.

type Listener = (url: string) => void;

let currentUrl = 'https://html.duckduckgo.com/';
const listeners = new Set<Listener>();

// Set when the USER kills the browser from the Live Browser header. Consumed
// by the next browser_* tool call so the agent learns why its session died.
let userKilledBrowser = false;

// Incremented each time the browser is killed — AgentBrowser uses this as
// a React key to force a full remount (fresh <webview> process).
let browserIncarnation = 0;

export const agentBrowserStore = {
  getUrl: () => currentUrl,
  getIncarnation: () => browserIncarnation,
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
  bumpIncarnation: () => { browserIncarnation++; },
};
