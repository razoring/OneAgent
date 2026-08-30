import { useEffect, useState } from 'react';
import { MessageSquarePlus, Settings, LayoutGrid, Pencil, Check, X, Trash2, Download, Globe, Loader2 } from 'lucide-react';
import SettingsModal from './SettingsModal';
import { chatStore, DEFAULT_TITLE } from '../utils/chatStore';
import { ChatMeta } from '../types/chat';
import { getBrowserSettings } from '../utils/llm';

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
    if (!confirmingDelete) {
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
                className="p-1 rounded-full transition-colors text-textSecondary hover:text-red-400 hover:bg-red-500/20"
                title="Delete chat"
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
                className="p-1 rounded-full transition-colors text-textSecondary hover:text-red-400 hover:bg-red-500/20"
                title="Delete chat"
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

// ─── Browser CDP launcher ────────────────────────────────────────────────────
const BrowserButton: React.FC = () => {
  const [launching, setLaunching] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const api: any = (window as any).electronAPI;
        if (!api?.chromeStatus) return;
        const r = await api.chromeStatus();
        if (!cancelled) setConnected(!!r?.listening);
      } catch {}
    };
    probe();
    const id = setInterval(probe, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const handleLaunch = async () => {
    if (launching) return;
    setLaunching(true);
    try {
      const api: any = (window as any).electronAPI;
      const s = getBrowserSettings();
      if (!api?.chromeLaunch) return;
      const doLaunch = async (opts: any) => api.chromeLaunch(opts);
      let res = await doLaunch({
        chromiumPath: s.chromiumPath || undefined,
        cdpPort: s.cdpPort,
        launchArgs: s.launchArgs || undefined,
      });
      if (res?.listening) { setConnected(true); return; }
      if (res?.success && res?.listening) { setConnected(true); return; }
      // Singleton lock: Chrome already running without --remote-debugging-port
      if (res?.needsRestart) {
        const alt = (res as any).alternative as { path: string; label: string } | undefined;
        const binName = res.binary ? String(res.binary).split(/[\\/]/).pop() : 'Chromium';
        const baseMsg = res.error || `Browser launch failed on port ${s.cdpPort}.`;
        let msg = baseMsg;
        if (alt) {
          msg += `\n\nAlternative available: ${alt.label} (${alt.path}) can run in parallel without closing ${binName}.`;
          msg += `\n\nOK = Force relaunch ${binName} (closes ALL ${binName} windows — live profile preserved, tabs will restore)\nCancel = Launch ${alt.label} instead`;
        } else {
          msg += `\n\nChromium singleton lock: the live profile is already in use by a running instance without debugging. Close all Chromium windows and relaunch?`;
          msg += `\n\nOK = Force relaunch (closes all windows)\nCancel = Abort`;
        }
        const force = confirm(msg);
        if (force) {
          // Force kill + relaunch same binary
          if (api.chromeForceRelaunch) {
            const r2 = await api.chromeForceRelaunch({
              chromiumPath: s.chromiumPath || undefined,
              cdpPort: s.cdpPort,
              launchArgs: s.launchArgs || undefined,
            });
            if (r2?.listening) setConnected(true);
            else alert('Force relaunch failed: ' + (r2?.error || 'unknown') + '\n\nIf it persists, manually close all Chromium windows via Task Manager and click Browser again.');
          } else {
            alert('Force relaunch not available in this build. Please manually close all Chromium windows and click Browser again.');
          }
        } else if (alt) {
          const r2 = await doLaunch({ chromiumPath: alt.path, cdpPort: s.cdpPort, launchArgs: s.launchArgs || undefined });
          if (r2?.listening) setConnected(true);
          else alert('Alternative launch failed: ' + (r2?.error || 'unknown'));
        }
        return;
      }
      if (!res?.success) alert('Browser launch failed: ' + (res?.error || 'unknown') + '\n\nTip: If another Chromium is running, close it or use Settings → Browser to pick a different Chromium (e.g., Edge if Chrome is busy) — they can run in parallel.');
    } catch (e: any) {
      alert('Browser launch failed: ' + (e?.message || String(e)));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <button
      onClick={handleLaunch}
      disabled={launching}
      className="flex items-center gap-3 w-full hover:bg-surfaceElevated transition-colors rounded-2xl p-3 text-left text-textSecondary disabled:opacity-60"
      title={connected ? 'External Chromium is listening — click to ensure running' : 'Launch external Chromium with --remote-debugging-port (auto-detect first click)'}
    >
      {launching ? <Loader2 size={18} className="animate-spin shrink-0" /> : <Globe size={18} className={connected ? 'text-green-400' : ''} />}
      <span className="flex-1">Browser</span>
      {connected ? <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" /> : null}
    </button>
  );
};

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
                {bucket.items.map(meta => (
                  <ChatRow key={meta.id} meta={meta} activeId={activeId} onSelect={handleSelect} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Bottom Section */}
      <div className="px-4 pb-4 space-y-1.5">
        <BrowserButton />
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
