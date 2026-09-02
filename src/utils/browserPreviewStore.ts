export class BrowserPreviewStore {
  private imagesByChat: Record<string, string[]> = {};
  private listeners: Set<() => void> = new Set();

  addImage(chatId: string, imageUrl: string) {
    if (!this.imagesByChat[chatId]) {
      this.imagesByChat[chatId] = [];
    }
    this.imagesByChat[chatId].push(imageUrl);
    this.notify();
  }

  getImages(chatId: string | null): string[] {
    if (!chatId) return [];
    return this.imagesByChat[chatId] || [];
  }

  clearImages(chatId: string) {
    delete this.imagesByChat[chatId];
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
