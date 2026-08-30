// CDP target store — mirrors agentBrowserStore but for external Chromium Targets.
// Each agent (or user) gets its own Target (page) via /json/new, enabling true
// parallel multitask on the live profile. Targets share cookies (live) but have
// isolated JS/DOM/Input.
import { getBrowserSettings } from './llm';

interface CdpTarget {
  id: string;
  wsUrl: string;
  url: string;
  title: string;
  agentId: string | null;
  port: number;
}

const targets = new Map<string, CdpTarget>(); // agentKey -> target
const targetById = new Map<string, CdpTarget>();
let cdpPort = 9222;

export const cdpBrowserStore = {
  getPort: (): number => {
    try { return getBrowserSettings().cdpPort || 9222; } catch { return cdpPort; }
  },
  setPort: (p: number) => { cdpPort = p; },

  getTargetForAgent: (agentId: string | null): CdpTarget | undefined => {
    const key = agentId || '__user__';
    return targets.get(key);
  },

  setTargetForAgent: (agentId: string | null, t: CdpTarget) => {
    const key = agentId || '__user__';
    targets.set(key, t);
    targetById.set(t.id, t);
  },

  getTargetById: (id: string) => targetById.get(id),

  removeByAgent: (agentId: string | null) => {
    const key = agentId || '__user__';
    const t = targets.get(key);
    if (t) {
      targets.delete(key);
      targetById.delete(t.id);
    }
  },

  list: (): CdpTarget[] => Array.from(targets.values()),

  async isCdpAvailable(): Promise<boolean> {
    try {
      const api: any = (window as any).electronAPI;
      if (!api?.chromeStatus) return false;
      const p = cdpBrowserStore.getPort();
      const r = await api.chromeStatus(p);
      return !!r?.listening;
    } catch { return false; }
  },

  async ensureTarget(agentId: string | null, url='https://html.duckduckgo.com/'): Promise<CdpTarget> {
    const existing = cdpBrowserStore.getTargetForAgent(agentId);
    if (existing) return existing;
    const api: any = (window as any).electronAPI;
    const port = cdpBrowserStore.getPort();
    // Try to list existing targets first — maybe one already created for this agent but not in store (after reload)
    try {
      const listRes = await api.chromeListTargets(port);
      const list: any[] = listRes?.targets || listRes || [];
      // Prefer a target whose title/url matches agent? For now, create new
      void list;
    } catch {}
    const res = await api.cdpNewTarget({ port, url });
    if (!res?.success || !res.target) throw new Error(res?.error || 'Failed to create CDP target');
    const tRaw: any = res.target;
    const t: CdpTarget = {
      id: tRaw.id,
      wsUrl: tRaw.webSocketDebuggerUrl,
      url: tRaw.url || url,
      title: tRaw.title || 'New Tab',
      agentId,
      port,
    };
    cdpBrowserStore.setTargetForAgent(agentId, t);
    return t;
  }
};
