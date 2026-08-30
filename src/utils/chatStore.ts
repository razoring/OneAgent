// Renderer-side chat history store. All disk IO goes through electronAPI
// IPC (see main.ts "Chat history persistence"). Owns the chat tree,
// the active (home) chat pointer and debounced autosave.
// Flat history only — no sub-agent transcript nesting.
import { ChatMeta, ChatFile, ChatMessage } from '../types/chat';
import { fileToBase64 } from './llm';

const api = () => (window as any).electronAPI;

const LAST_CHAT_KEY = 'oneagent_last_chat';

export const DEFAULT_TITLE = 'New Chat';

let chats: ChatMeta[] = [];
let activeId: string | null = null;
let ready = false;

const chatListeners = new Set<(c: ChatMeta[]) => void>();
const activeListeners = new Set<(id: string | null) => void>();
const readyListeners = new Set<(r: boolean) => void>();

const notifyChats = () => chatListeners.forEach(l => l([...chats]));
const notifyActive = () => activeListeners.forEach(l => l(activeId));
const notifyReady = () => readyListeners.forEach(l => l(ready));

const sortChats = () => {
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
};

// ─── Attachment persistence ──────────────────────────────────────────────────
// Image attachments are inlined as data URLs so the main process can hoist
// them into the chat's assets/ folder. Non-image documents keep their
// metadata (their parsed text already lives in the model context).

const PERSIST_MAX_FILE_BYTES = 25 * 1024 * 1024;

const sanitizeAttachments = async (messages: ChatMessage[]): Promise<ChatMessage[]> => {
  const out = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const atts = msg.attachments;
    if (!atts || atts.length === 0) { out[i] = msg; continue; }
    const nextAtts: any[] = [];
    for (const att of atts) {
      const clean: any = { ...att };
      const f: File | undefined = att.file;
      if (f) {
        if (att.type === 'image' && f.size <= PERSIST_MAX_FILE_BYTES) {
          try { clean.url = await fileToBase64(f); } catch { /* keep whatever url existed */ }
        }
        delete clean.file;
      }
      if (typeof clean.thumbnail === 'string' && clean.thumbnail.startsWith('blob:')) delete clean.thumbnail;
      if (typeof clean.url === 'string' && clean.url.startsWith('blob:')) delete clean.url;
      nextAtts.push(clean);
    }
    out[i] = { ...msg, attachments: nextAtts };
  }
  return out;
};

const stripRuntimeFields = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map(m => ({
    ...m,
    isGenerating: false,
    isCallingTool: false,
    ...(m.thinkingParts?.length ? {} : { thinkingParts: undefined }),
    ...(m.toolCalls?.length ? {} : { toolCalls: undefined })
  }));

// ─── Debounced saves ─────────────────────────────────────────────────────────

const DEBOUNCE_MS = 700;
const MAX_WAIT_MS = 4000;

interface PendingSave { payload: ChatMessage[]; timer: any; firstAt: number }
const pending = new Map<string, PendingSave>();

const doSave = async (chatId: string, messages: ChatMessage[]) => {
  try {
    const cleaned = stripRuntimeFields(await sanitizeAttachments(messages));
    await api().chatsSave(chatId, { messages: cleaned });
  } catch (e) {
    console.error('[chatStore] save failed', e);
  }
};

const scheduleFlush = (chatId: string, entry: PendingSave) => {
  clearTimeout(entry.timer);
  const wait = Math.max(0, DEBOUNCE_MS - (Date.now() - entry.firstAt));
  entry.timer = setTimeout(() => {
    pending.delete(chatId);
    void doSave(chatId, entry.payload);
  }, wait);
};

// ─── Store ───────────────────────────────────────────────────────────────────

export const chatStore = {
  get isReady() { return ready; },

  subscribeReady(l: (r: boolean) => void) {
    readyListeners.add(l);
    if (ready) l(true);
    return () => { readyListeners.delete(l); };
  },

  subscribeChats(l: (c: ChatMeta[]) => void) {
    chatListeners.add(l);
    l([...chats]);
    return () => { chatListeners.delete(l); };
  },

  subscribeActive(l: (id: string | null) => void) {
    activeListeners.add(l);
    l(activeId);
    return () => { activeListeners.delete(l); };
  },

  getChats: (): ChatMeta[] => [...chats],
  getActiveId: (): string | null => activeId,
  getMeta: (id: string | null): ChatMeta | undefined => chats.find(c => c.id === id),

  setActive(id: string | null) {
    if (activeId === id) return;
    activeId = id;
    if (id) localStorage.setItem(LAST_CHAT_KEY, id);
    notifyActive();
  },

  // Idempotent startup: load the tree, restore the last active chat (or the
  // most recent one, or bootstrap a fresh root chat).
  initOnce: (): Promise<void> => {
    if (ready) return Promise.resolve();
    return (chatStore as any)._init ?? ((chatStore as any)._init = (async () => {
      try {
        const res = await api().chatsList();
        chats = (res?.chats || []) as ChatMeta[];
        sortChats();
        const last = localStorage.getItem(LAST_CHAT_KEY);
        const lastChat = last ? chats.find(c => c.id === last) : undefined;
        let candidate =
          (lastChat && lastChat.parentId === null ? lastChat.id : undefined) ??
          chats.find(c => c.parentId === null)?.id ??
          null;
        if (!candidate) {
          const meta = await chatStore.createChat(null);
          candidate = meta.id;
        }
        activeId = candidate;
        if (activeId) localStorage.setItem(LAST_CHAT_KEY, activeId);
      } catch (e) {
        console.error('[chatStore] init failed', e);
        chats = [];
        activeId = null;
      } finally {
        ready = true;
        notifyChats();
        notifyActive();
        notifyReady();
      }
    })());
  },

  refresh: async () => {
    const res = await api().chatsList();
    chats = (res?.chats || []) as ChatMeta[];
    sortChats();
    notifyChats();
  },

  async createChat(parentId: string | null, title: string = DEFAULT_TITLE): Promise<ChatMeta> {
    const res = await api().chatsCreate({ parentId: parentId ?? null, title });
    if (!res?.success) throw new Error(res?.error || 'Failed to create chat');
    const meta = res.meta as ChatMeta;
    chats.push(meta);
    sortChats();
    notifyChats();
    return meta;
  },

  async rename(chatId: string, title: string): Promise<void> {
    const res = await api().chatsRename(chatId, title);
    if (!res?.success) throw new Error(res?.error || 'Rename failed');
    const meta = res.meta as ChatMeta;
    const i = chats.findIndex(c => c.id === chatId);
    if (i >= 0) { chats[i] = meta; sortChats(); notifyChats(); }
  },

  // Deletes the chat (cascades to any children, though flat history has none).
  async delete(chatId: string): Promise<void> {
    const res = await api().chatsDelete(chatId);
    if (!res?.success) throw new Error(res?.error || 'Delete failed');
    pending.delete(chatId);
    try {
      const { taskStore } = await import('./taskStore');
      taskStore.forget(chatId);
    } catch {}
    chats = chats.filter(c => c.id !== chatId);
    notifyChats();
    if (activeId === chatId) {
      const next = chats.find(c => c.parentId === null)?.id ?? chats[0]?.id ?? null;
      if (next) chatStore.setActive(next);
      else {
        const meta = await chatStore.createChat(null);
        chatStore.setActive(meta.id);
      }
    }
  },

  async exportZip(chatId: string): Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }> {
    return api().chatsExportZip(chatId);
  },

  async loadMessages(chatId: string): Promise<ChatMessage[]> {
    const res = await api().chatsLoad(chatId);
    if (!res?.success) return [];
    const file = res.file as ChatFile;
    // Hydrate per-chat tasks (persistent, UI-only, not LLM context) alongside messages.
    try {
      const { taskStore } = await import('./taskStore');
      taskStore.hydrate(chatId, (file as any).tasks || []);
    } catch {}
    return (file.messages || []) as ChatMessage[];
  },

  // Immediate save (used on completion boundaries).
  async saveMessages(chatId: string, messages: ChatMessage[]): Promise<void> {
    const existing = pending.get(chatId);
    if (existing) { clearTimeout(existing.timer); pending.delete(chatId); }
    await doSave(chatId, messages);
  },

  saveMessagesDebounced(chatId: string, messages: ChatMessage[]): void {
    if (!chatId) return;
    const now = Date.now();
    const existing = pending.get(chatId);
    if (existing) {
      existing.payload = messages;
      if (now - existing.firstAt >= MAX_WAIT_MS) {
        clearTimeout(existing.timer);
        pending.delete(chatId);
        void doSave(chatId, messages);
      } else {
        scheduleFlush(chatId, existing);
      }
      return;
    }
    const entry: PendingSave = { payload: messages, timer: null as any, firstAt: now };
    pending.set(chatId, entry);
    scheduleFlush(chatId, entry);
  },

  // Force-write anything pending (chat switch, window close).
  flushSaves(): void {
    for (const [chatId, entry] of [...pending.entries()]) {
      clearTimeout(entry.timer);
      pending.delete(chatId);
      void doSave(chatId, entry.payload);
    }
  }
};
