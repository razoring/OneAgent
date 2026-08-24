import { useEffect, useState } from 'react';
import { MessageSquarePlus, Settings, LayoutGrid, Pencil, Check, X, Trash2, Download, Bot } from 'lucide-react';
import SettingsModal from './SettingsModal';
import { chatStore, DEFAULT_TITLE } from '../utils/chatStore';
import { ChatMeta } from '../types/chat';

// ─── Date bucketing ──────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

const bucketStartOfDay = (offsetDays: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - offsetDays * DAY;
};

const bucketLabel = (ts: number): string => {
  const today = bucketStartOfDay(0);
  if (ts >= today) return 'Today';
  if (ts >= today - 6 * DAY) return 'Previous 7 Days';
  if (ts >= today - 29 * DAY) return 'Previous 30 Days';
  return 'Older';
};

const BUCKET_ORDER = ['Today', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

// ─── Chat row ────────────────────────────────────────────────────────────────

interface ChatRowProps {
  meta: ChatMeta;
  activeId: string | null;
  onSelect: (id: string) => void;
}

const ChatRow = ({ meta, activeId, onSelect }: ChatRowProps) => {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const childCount = chatStore.getChats().filter(c => c.parentId === meta.id).length;
  const isActive = activeId === meta.id;

  useEffect(() => {
    if (!confirmingDelete) return;
    const t = setTimeout(() => setConfirmingDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmingDelete]);

  const startRename = () => {
    setRenameValue(meta.title);
    setRenaming(true);
  };

  const commitRename = async () => {
    const title = renameValue.trim();
    setRenaming(false);
    if (title && title !== meta.title) {
      try { await chatStore.rename(meta.id, title); } catch (e) { console.error(e); }
    }
  };

  const handleDelete = async () => {
    // Leaf chats delete immediately; cascading deletes ask once.
    if (childCount > 0 && !confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    try { await chatStore.delete(meta.id); } catch (e) { console.error(e); }
  };

  return (
    <div className="relative group">
      <button
        onClick={() => !renaming && onSelect(meta.id)}
        className={`w-full text-left p-3 pr-9 rounded-2xl truncate transition-colors ${
          isActive ? 'bg-surfaceElevated text-white' : 'text-textSecondary hover:bg-surface'
        }`}
        title={meta.title}
      >
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {meta.agentId && <Bot size={13} className="shrink-0 text-accentBright/80" />}
          {renaming ? (
            <input
              autoFocus
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onClick={e => e.stopPropagation()}
              onKeyDown={e => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              onBlur={commitRename}
              className="w-full bg-black/40 border border-accent/40 rounded-lg px-2 py-0.5 text-sm text-white focus:outline-none"
            />
          ) : (
            <span className="truncate">{meta.title || DEFAULT_TITLE}</span>
          )}
        </span>
      </button>

      {/* Hover actions */}
      {!renaming && (
        <div
          className={`absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 p-0.5 rounded-full mac-element border border-white/5 transition-opacity ${
            confirmingDelete ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
          }`}
        >
          {confirmingDelete ? (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(); }}
                className={`p-1 rounded-full transition-colors ${childCount > 0 ? 'text-red-400 hover:bg-red-500/20' : 'text-textSecondary hover:text-red-400 hover:bg-red-500/20'}`}
                title={childCount > 0 ? `Delete chat and ${childCount} nested chat${childCount === 1 ? '' : 's'}` : 'Delete chat'}
              >
                <Check size={12} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setConfirmingDelete(false); }}
                className="p-1 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors"
                title="Cancel"
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); startRename(); }}
                className="p-1 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors"
                title="Rename"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void chatStore.exportZip(meta.id).catch(err => console.error('[chatStore] export failed', err));
                }}
                className="p-1 text-textSecondary hover:text-gray-200 hover:bg-white/10 rounded-full transition-colors"
                title="Export as .zip"
              >
                <Download size={12} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(); }}
                className={`p-1 rounded-full transition-colors ${childCount > 0 ? 'text-textSecondary hover:text-red-400 hover:bg-red-500/20' : 'text-textSecondary hover:text-red-400 hover:bg-red-500/20'}`}
                title={childCount > 0 ? `Delete chat and ${childCount} nested chat${childCount === 1 ? '' : 's'}` : 'Delete chat'}
              >
                <Trash2 size={12} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Recursive tree section ──────────────────────────────────────────────────

interface TreeSectionProps {
  metas: ChatMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}

const TreeSection = ({ metas, activeId, onSelect, depth = 0 }: TreeSectionProps) => (
  <>
    {metas.map(meta => {
      const children = chatStore.childrenOf(meta.id);
      return (
        <div key={meta.id}>
          <ChatRow meta={meta} activeId={activeId} onSelect={onSelect} />
          {/* Nested chats: indented under the parent with a vertical line */}
          {children.length > 0 && (
            <div className={`flex flex-col gap-0.5 mt-0.5 mb-1 ml-[15px] pl-3 border-l border-white/10 ${depth > 0 ? 'ml-[27px]' : ''}`}>
              <TreeSection metas={children} activeId={activeId} onSelect={onSelect} depth={depth + 1} />
            </div>
          )}
        </div>
      );
    })}
  </>
);

// ─── Sidebar ─────────────────────────────────────────────────────────────────

const Sidebar = () => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [ready, setReady] = useState(chatStore.isReady);

  useEffect(() => {
    const unsubs = [
      chatStore.subscribeReady(setReady),
      chatStore.subscribeChats(setChats),
      chatStore.subscribeActive(setActiveId)
    ];
    void chatStore.initOnce();
    return () => unsubs.forEach(u => u());
  }, []);

  const roots = chats.filter(c => c.parentId === null);

  const buckets = BUCKET_ORDER.map(label => ({
    label,
    items: roots.filter(c => bucketLabel(c.updatedAt) === label)
  })).filter(b => b.items.length > 0);

  const handleNewChat = async () => {
    try {
      const meta = await chatStore.createChat(null);
      chatStore.setActive(meta.id);
    } catch (e) {
      console.error('[Sidebar] failed to create chat', e);
    }
  };

  const handleSelect = (id: string) => {
    chatStore.flushSaves();
    chatStore.setActive(id);
  };

  return (
    <div className="w-[280px] bg-background flex flex-col h-full text-sm">
      {/* Top Section */}
      <div className="p-4">
        <button
          onClick={handleNewChat}
          className="flex items-center gap-3 w-full mac-element mac-element-hover transition-all rounded-[28px] p-3.5 text-left font-medium text-white"
        >
          <div className="bg-white/10 text-white p-1.5 rounded-full">
            <MessageSquarePlus size={18} />
          </div>
          New Chat
        </button>
      </div>

      {/* Chat History */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1.5">
        {!ready ? (
          <div className="text-xs text-textSecondary px-2 py-4 italic">Loading chats…</div>
        ) : buckets.length === 0 ? (
          <div className="text-xs text-textSecondary px-2 py-4 italic">No chats yet</div>
        ) : (
          buckets.map(bucket => (
            <div key={bucket.label} className="mb-2">
              <div className="text-xs font-semibold text-textSecondary mb-2 px-2">{bucket.label}</div>
              <div className="space-y-1">
                <TreeSection metas={bucket.items} activeId={activeId} onSelect={handleSelect} />
              </div>
            </div>
          ))
        )}
      </div>

      {/* Bottom Section */}
      <div className="px-4 pb-4 space-y-1.5">
        <button className="flex items-center gap-3 w-full hover:bg-surfaceElevated transition-colors rounded-2xl p-3 text-left text-textSecondary">
          <LayoutGrid size={18} />
          Models
        </button>
        <button
          onClick={() => setIsSettingsOpen(true)}
          className="flex items-center gap-3 w-full hover:bg-surfaceElevated transition-colors rounded-2xl p-3 text-left text-textSecondary"
        >
          <Settings size={18} />
          Settings
        </button>
      </div>

      {isSettingsOpen && (
        <SettingsModal onClose={() => setIsSettingsOpen(false)} />
      )}
    </div>
  );
};

export default Sidebar;
