// Multi-tab embedded browser shared by the user and all agents.
// Each actor (user / agent id) gets its own tab with its own <webview>,
// so agents can browse concurrently without stealing each other's pages.
//
// The webview ELEMENTS live in a module-level registry (window.__oneagentTabs)
// owned by AgentBrowser; this store holds metadata + routing + follow mode.

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  // Owning actor id (sub-agent registry id). null = user tab.
  agentId: string | null;
  // Human label shown next to agent tabs (agent label).
  label?: string;
  // True while the owning actor has a browser tool call in flight.
  busy?: boolean;
  loading?: boolean;
}

type TabsListener = (tabs: BrowserTab[]) => void;
type ActiveListener = (tabId: string | null) => void;

const HOME_URL = 'https://html.duckduckgo.com/';

let tabs: BrowserTab[] = [];
let activeTabId: string | null = null;

// Session kill flag + termination snapshot (single-webview era carryovers).
let userKilledBrowser = false;
let terminatedSnapshot: string | null = null;
const snapshotListeners = new Set<(img: string | null) => void>();

const tabsListeners = new Set<TabsListener>();
const activeListeners = new Set<ActiveListener>();

let seq = 0;
const genId = () => `tab-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const emitTabs = () => tabsListeners.forEach(l => l([...tabs]));
const emitActive = () => activeListeners.forEach(l => l(activeTabId));

export const agentBrowserStore = {
  HOME_URL,

  getTabs: (): BrowserTab[] => [...tabs],
  getActiveId: (): string | null => activeTabId,
  getActiveTab: (): BrowserTab | undefined => tabs.find(t => t.id === activeTabId),
  getTab: (id: string): BrowserTab | undefined => tabs.find(t => t.id === id),
  getTabIdForAgent: (agentId: string): string | undefined =>
    tabs.find(t => t.agentId === agentId)?.id,

  subscribeTabs: (l: TabsListener) => {
    tabsListeners.add(l);
    l([...tabs]);
    return () => { tabsListeners.delete(l); };
  },

  subscribeActive: (l: ActiveListener) => {
    activeListeners.add(l);
    l(activeTabId);
    return () => { activeListeners.delete(l); };
  },

  ensureHomeTab: (): BrowserTab => {
    const existing = tabs.find(t => t.agentId === null);
    if (existing) return existing;
    const tab: BrowserTab = { id: genId(), title: 'New Tab', url: HOME_URL, agentId: null };
    tabs.push(tab);
    if (!activeTabId) activeTabId = tab.id;
    emitTabs();
    emitActive();
    return tab;
  },

  // Fresh user tab every call ("+" button). Home tab dedupe lives in
  // ensureHomeTab; this always creates.
  createUserTab: (): BrowserTab => {
    const tab: BrowserTab = { id: genId(), title: 'New Tab', url: HOME_URL, agentId: null };
    tabs.push(tab);
    activeTabId = tab.id;
    emitTabs();
    emitActive();
    return tab;
  },

  // A link opened via target=_blank / window.open lands here as its own tab.
  openUrlInNewTab: (url: string): BrowserTab => {
    const tab: BrowserTab = { id: genId(), title: 'New Tab', url, agentId: null, loading: true };
    tabs.push(tab);
    activeTabId = tab.id;
    emitTabs();
    emitActive();
    return tab;
  },

  // One tab per agent — repeated spawns reuse the same tab per actor id.
  ensureAgentTab: (agentId: string, label?: string): BrowserTab => {
    const existing = tabs.find(t => t.agentId === agentId);
    if (existing) {
      if (label && existing.label !== label) {
        existing.label = label;
        emitTabs();
      }
      return existing;
    }
    const tab: BrowserTab = { id: genId(), title: label || 'Agent tab', url: HOME_URL, agentId, label };
    tabs.push(tab);
    emitTabs();
    return tab;
  },

  activateTab: (id: string) => {
    if (!tabs.some(t => t.id === id)) return;
    if (activeTabId === id) return;
    activeTabId = id;
    emitActive();
  },

  closeTab: (id: string) => {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const wasActive = activeTabId === id;
    tabs.splice(idx, 1);
    if (wasActive) {
      activeTabId = tabs[Math.max(0, idx - 1)]?.id ?? null;
      emitActive();
    }
    emitTabs();
  },

  patchTab: (id: string, patch: Partial<Omit<BrowserTab, 'id'>>) => {
    const tab = tabs.find(t => t.id === id);
    if (!tab) return;
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if ((tab as any)[k] !== v) { (tab as any)[k] = v; changed = true; }
    }
    if (changed) emitTabs();
  },

  isFollowMode: () => false,
  setFollowMode: (_on: boolean) => { /* follow mode removed — tab switching is click-driven */ },

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
  subscribeSnapshot: (l: (img: string | null) => void) => {
    snapshotListeners.add(l);
    return () => { snapshotListeners.delete(l); };
  },

  // Called when an actor starts/ends browser tool activity — drives the busy
  // pulse on the agent's tab. The VISIBLE tab never switches automatically:
  // the user browses freely, and opens an agent's tab by clicking its chat.
  markActorBusy: (agentId: string | null | undefined, busy: boolean, _label?: string) => {
    if (!agentId) return;
    const tab = tabs.find(t => t.agentId === agentId);
    if (!tab || tab.busy === busy) return;
    tab.busy = busy;
    emitTabs();
  }
};

// ─── Actor routing ───────────────────────────────────────────────────────────
// browser_* tools resolve their target webview through the CURRENT actor:
// sub-agents hit their own tab; the user/orchestrator hit the visible one.

let currentActor: string | null = null;

export const setBrowserActor = (agentId: string | null | undefined) => {
  currentActor = agentId ?? null;
};

export const getCurrentActor = (): string | null => currentActor;

// Legacy single-webview fields kept in sync for any stray consumers.
export const syncLegacyGlobals = (visibleWv: any, ready: boolean) => {
  (window as any).activeWebview = visibleWv;
  (window as any).activeWebviewReady = ready;
};
