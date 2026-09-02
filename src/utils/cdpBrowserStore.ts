// CDP target store for internal WebContentsView.
// Maps agentId to its corresponding webContentsId (the "Target" in CDP terms).

interface CdpTarget {
  id: string; // The webContentsId as a string
  url: string;
  agentId: string | null;
}

const targets = new Map<string, CdpTarget>(); // agentKey -> target

export const cdpBrowserStore = {
  getTargetForAgent: (agentId: string | null): CdpTarget | undefined => {
    const key = agentId || '__user__';
    return targets.get(key);
  },

  setTargetForAgent: (agentId: string | null, t: CdpTarget) => {
    const key = agentId || '__user__';
    targets.set(key, t);
  },

  removeByAgent: (agentId: string | null) => {
    const key = agentId || '__user__';
    targets.delete(key);
  },

  list: (): CdpTarget[] => Array.from(targets.values()),

  async ensureTarget(agentId: string | null, url='https://html.duckduckgo.com/'): Promise<CdpTarget> {
    const existing = cdpBrowserStore.getTargetForAgent(agentId);
    if (existing) return existing;
    
    const api = (window as any).electronAPI;
    const res = await api.createAgentBrowser(agentId || 'default', url);
    if (!res?.success) throw new Error(res?.error || 'Failed to create agent browser');
    
    const t: CdpTarget = {
      id: String(res.webContentsId),
      url: url,
      agentId,
    };
    cdpBrowserStore.setTargetForAgent(agentId, t);
    return t;
  }
};
