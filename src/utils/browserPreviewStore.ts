export class BrowserPreviewStore {
  private imagesByAgent: Record<string, string[]> = {};
  private listeners: Set<() => void> = new Set();

  addImage(agentId: string, imageUrl: string) {
    if (!this.imagesByAgent[agentId]) {
      this.imagesByAgent[agentId] = [];
    }
    this.imagesByAgent[agentId].push(imageUrl);
    this.notify();
  }

  getImages(agentId: string | null): string[] {
    if (!agentId) return [];
    return this.imagesByAgent[agentId] || [];
  }

  clearImages(agentId: string) {
    delete this.imagesByAgent[agentId];
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
