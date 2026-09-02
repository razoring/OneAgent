export class BrowserPreviewStore {
  private imagesByAgent: Record<string, string[]> = {};
  private listeners: Set<() => void> = new Set();

  addImage(agentId: string | null | undefined, imageUrl: string) {
    const key = agentId || 'default';
    if (!this.imagesByAgent[key]) {
      this.imagesByAgent[key] = [];
    }
    this.imagesByAgent[key].push(imageUrl);
    this.notify();
  }

  getImages(agentId: string | null | undefined): string[] {
    const key = agentId || 'default';
    if (this.imagesByAgent[key] && this.imagesByAgent[key].length > 0) {
      return this.imagesByAgent[key];
    }
    const all = Object.values(this.imagesByAgent);
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].length > 0) return all[i];
    }
    return [];
  }

  clearImages(agentId: string | null | undefined) {
    const key = agentId || 'default';
    delete this.imagesByAgent[key];
    this.notify();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(l => l());
  }
}

export const browserPreviewStore = new BrowserPreviewStore();

