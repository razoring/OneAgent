import {
  browserKeystrokesLegacyRouter,
  browserScroll,
  browserType,
  browserClick,
  browserHold,
  browserMove,
  browserDragTo,
  browserPressKey,
  browserEvaluateScript,
  browserSelectOptionById,
  browserWaitForTextOrSelector,
  browserSetUserAgent,
  browserObservePage,
  captureBrowserScreenshot,
  executeBrowserNavigation,
  executeBrowserTerminate,
  getSemanticDOM,
  waitForActiveWebview
} from './browserTools';
import { setBrowserActor } from './agentBrowserStore';
import { getWebSearchSettings, downscaleDataUrl } from './llm';
import { TOOL_TIERS } from './tools';
import { userPromptStore } from './userPromptStore';
import { agentBrowserStore } from './agentBrowserStore';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolResult {
  result: string;
  imageDataUrl?: string;
  error?: boolean;
}

export interface NamedToolResult extends ToolResult {
  toolName: string;
}

// Capabilities the executor needs from its host (a sub-agent runner).
// Keeps this module free of React/state imports.
export interface ToolContext {
  requestApproval: (toolName: string, summary: string) => Promise<{ approved: boolean; message?: string }>;
  // When set, ask_user prompts flip this formal task's needsInput flag.
  promptTaskId?: string;
  // The calling sub-agent's own bound task id — complete_task can ONLY mark
  // this one task done, never anyone else's.
  ownTaskId?: string;
  // Acting sub-agent id — routes browser_* calls to this agent's OWN tab.
  agentId?: string;
  signal?: AbortSignal;
}

// ─── Parsing & helpers ───────────────────────────────────────────────────────

export const parseToolCall = (raw: string): { name: string; args: any } => {
  try {
    const parsed = JSON.parse(raw);
    return { name: parsed.name || parsed.toolName || 'unknown_tool', args: parsed.arguments || parsed.args || {} };
  } catch {
    return { name: 'unknown_tool', args: {} };
  }
};

// First defined/non-null value wins; legacy param names are covered here so
// old conversation replays keep working.
const p = (a: any, ...keys: string[]): any => {
  if (!a) return undefined;
  for (const k of keys) {
    if (a[k] !== undefined && a[k] !== null) return a[k];
  }
  return undefined;
};

const j = (v: any): string => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

// Short human-readable description for permission cards.
export const summarizeArgs = (name: string, args: any): string => {
  try {
    switch (name) {
      case 'run_command': return String(p(args, 'command') || '');
      case 'delete_file': return String(p(args, 'path', 'filePath') || '');
      case 'switch_model': return `${p(args, 'provider') ? p(args, 'provider') + '/' : ''}${p(args, 'model') || ''}`;
      case 'update_settings': return Object.entries(args).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(', ');
      case 'desktop_click': return `(${p(args, 'x', 'X')}, ${p(args, 'y', 'Y')})`;
      case 'desktop_drag': return `(${p(args, 'from_x', 'fromX')}, ${p(args, 'from_y', 'fromY')}) → (${p(args, 'to_x', 'toX')}, ${p(args, 'to_y', 'toY')})`;
      case 'desktop_type': return `"${String(p(args, 'text') || '').slice(0, 60)}"`;
      case 'desktop_hotkey': return (p(args, 'keys') || []).join('+');
      default: return j(args).slice(0, 120);
    }
  } catch {
    return '';
  }
};

// Browser tabs are now parallel: each WebContentsView runs in its own renderer
// with isolated partition. Browser tools serialize per-tab (per-actor), not
// globally. Desktop tools still share one global lock (single host mouse).
const lockKeyFor = (name: string, ctx: ToolContext): string | null => {
  if (name.startsWith('browser') || name === 'find_in_page') {
    // Per-agent tab isolation — user (null) gets its own key
    return `browser:${ctx.agentId ?? '__user__'}`;
  }
  if (name.startsWith('desktop')) return 'desktop';
  return null;
};

// ─── Handlers ────────────────────────────────────────────────────────────────

type Handler = (args: any, ctx: ToolContext) => Promise<ToolResult>;

const ok = (result: string): ToolResult => ({ result });

const HANDLERS: Record<string, Handler> = {
  // Files & system
  view_file: async (args) => {
    const res = await (window as any).electronAPI.viewFile(p(args, 'path', 'AbsolutePath', 'filePath', 'targetFile'));
    return ok(j(res));
  },
  list_dir: async (args) => {
    const res = await (window as any).electronAPI.listDir(p(args, 'path', 'DirectoryPath', 'dirPath') ?? '.');
    return ok(j(res));
  },
  search_files: async (args) => {
    const query = p(args, 'query');
    if (!query) throw new Error("search_files requires 'query'");
    const res = await (window as any).electronAPI.grepSearch({
      query,
      path: p(args, 'path'),
      isRegex: !!p(args, 'is_regex', 'isRegex'),
      maxResults: Number(p(args, 'max_results', 'maxResults') ?? 200) || 200
    });
    return ok(j(res));
  },
  write_to_file: async (args) => {
    const res = await (window as any).electronAPI.writeToFile({
      targetFile: p(args, 'path', 'targetFile', 'TargetFile', 'filePath'),
      codeContent: p(args, 'content', 'codeContent', 'CodeContent') ?? '',
      overwrite: p(args, 'overwrite', 'Overwrite') ?? true
    });
    return ok(j(res));
  },
  replace_file_content: async (args) => {
    const res = await (window as any).electronAPI.replaceFileContent({
      targetFile: p(args, 'path', 'targetFile', 'TargetFile', 'filePath'),
      targetContent: p(args, 'find', 'targetContent', 'TargetContent') ?? '',
      replacementContent: p(args, 'replace', 'replacementContent', 'ReplacementContent') ?? ''
    });
    return ok(j(res));
  },
  delete_file: async (args) => {
    const res = await (window as any).electronAPI.deleteFile(p(args, 'path', 'filePath', 'FilePath'));
    return ok(j(res));
  },
  run_command: async (args) => {
    const res = await (window as any).electronAPI.runCommand(
      p(args, 'command', 'Command', 'cmd'),
      p(args, 'cwd', 'Cwd'),
      Number(p(args, 'timeout_ms', 'timeoutMs')) || undefined
    );
    return ok(j(res));
  },

  // Web search
  search_web: async (args) => {
    const query = p(args, 'query', 'Query') ?? '';
    const limit = Number(p(args, 'limit', 'Limit')) || 5;
    const { endpoint, apiKey } = getWebSearchSettings();
    if (!endpoint.trim()) {
      return ok(j({
        success: false,
        error: 'No search API configured. Use the embedded browser instead: browser_navigate to https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query)
      }));
    }
    const res = await (window as any).electronAPI.searchWeb({ endpoint, apiKey, query, limit });
    return ok(j(res));
  },

  // Embedded browser — navigation & observation
  browser_navigate: async (args) => {
    let url: string = String(p(args, 'url', 'Url') ?? '').trim() || 'https://html.duckduckgo.com';
    if (!/^https?:\/\//i.test(url)) {
      if (url.includes('.') && !url.includes(' ')) url = 'https://' + url;
      else url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(url);
    }
    return ok(await executeBrowserNavigation('navigate', url));
  },
  browser_go_back: async () => ok(await executeBrowserNavigation('back')),
  browser_terminate: async () => ok(await executeBrowserTerminate()),
  browser_get_dom: async () => ok(await getSemanticDOM()),
  browser_observe: async () => {
    const obs = await browserObservePage();
    return {
      result: j({
        success: true,
        image: 'Annotated browser screenshot attached to this tool response.',
        elements: obs.markers.length > 0 ? obs.markers : undefined,
        dom: obs.dom.length > 0 ? obs.dom : undefined,
        meta: obs.meta && Object.keys(obs.meta).length > 0 ? obs.meta : undefined,
        note: obs.markers.length > 0 ? 'Numbered color-coded badges are Set-of-Mark IDs — use them with browser_click/browser_type etc. Each badge shares its color with the outline of its element.' : undefined
      }),
      imageDataUrl: await downscaleDataUrl(obs.image, 1280, 0.92)
    };
  },
  browser_screenshot: async () => {
    const shot = await captureBrowserScreenshot();
    return {
      result: j({
        success: true,
        image: 'Screenshot of the embedded browser viewport attached to this tool response.',
        elements: shot.markers.length > 0 ? shot.markers : undefined
      }),
      imageDataUrl: await downscaleDataUrl(shot.image, 1280, 0.92)
    };
  },

  // Embedded browser — virtual input primitives
  browser_click: async (args) => ok(await browserClick(args)),
  browser_mouse_down: async (args) => ok(await browserHold(args, 'down')),
  browser_mouse_up: async (args) => ok(await browserHold(args, 'up')),
  browser_mouse_move: async (args) => ok(await browserMove(args)),
  browser_drag: async (args) => ok(await browserDragTo(args)),
  browser_key: async (args) => ok(await browserPressKey(args)),
  browser_type: async (args) => ok(await browserType(args)),
  browser_scroll: async (args) => ok(await browserScroll(args)),

  // Embedded browser — internals
  browser_evaluate: async (args) => ok(await browserEvaluateScript(args)),
  browser_cookies: async (args) => {
    const wv = await waitForActiveWebview();
    const res = await (window as any).electronAPI.browserCookies({
      webContentsId: wv.getWebContentsId(),
      op: p(args, 'op', 'Op') ?? 'get',
      name: p(args, 'name'),
      value: p(args, 'value'),
      domain: p(args, 'domain'),
      url: p(args, 'url'),
      expirationDate: p(args, 'expiration_date', 'expirationDate')
    });
    return ok(j(res));
  },
  browser_history: async (args) => {
    const wv = await waitForActiveWebview();
    const res = await (window as any).electronAPI.browserHistory({
      webContentsId: wv.getWebContentsId(),
      op: p(args, 'op', 'Op') ?? 'list',
      index: p(args, 'index')
    });
    return ok(j(res));
  },
  browser_storage: async (args) => {
    const wv = await waitForActiveWebview();
    const op = String(p(args, 'op') ?? 'get');
    const store = p(args, 'type') === 'session' ? 'sessionStorage' : 'localStorage';
    const key = p(args, 'key');
    const value = p(args, 'value');
    let script: string;
    if (op === 'get') {
      script = key !== undefined
        ? `${store}.getItem(${JSON.stringify(String(key))})`
        : `JSON.stringify(Object.fromEntries(Object.entries({ ...${store} }).slice(0, 80)))`;
    } else if (op === 'set' && key !== undefined) {
      script = `${store}.setItem(${JSON.stringify(String(key))}, ${JSON.stringify(String(value ?? ''))}), 'stored'`;
    } else if (op === 'remove' && key !== undefined) {
      script = `${store}.removeItem(${JSON.stringify(String(key))}), 'removed'`;
    } else if (op === 'clear') {
      script = `${store}.clear(), 'cleared'`;
    } else {
      throw new Error(`browser_storage: op "${op}" requires a key`);
    }
    const out = await wv.executeJavaScript(script);
    return ok(out === null ? `null (key not set)` : typeof out === 'string' && out.startsWith('{') ? out : `Result: ${out}`);
  },
  browser_select_option: async (args) => ok(await browserSelectOptionById(args)),
  browser_wait_for: async (args) => ok(await browserWaitForTextOrSelector(args)),
  find_in_page: async (args) => {
    const wv = await waitForActiveWebview();
    const text = p(args, 'text', 'Text');
    if (!text) throw new Error("find_in_page requires 'text'");
    const res = await (window as any).electronAPI.findInPage({ webContentsId: wv.getWebContentsId(), text });
    return ok(j(res));
  },
  browser_download: async (args) => {
    const wv = await waitForActiveWebview();
    const res = await (window as any).electronAPI.browserDownload({
      webContentsId: wv.getWebContentsId(),
      url: p(args, 'url', 'Url'),
      savePath: p(args, 'save_path', 'savePath')
    });
    return ok(j(res));
  },
  browser_set_user_agent: async (args) => ok(await browserSetUserAgent(args)),

  // Desktop automation (approval-gated upstream)
  desktop_screenshot: async () => {
    const screenRes = await (window as any).electronAPI.takeScreenshot();
    if (screenRes?.success && screenRes.image) {
      return { result: j({ success: true, image: "Screenshot of the user's monitor attached to this tool response." }), imageDataUrl: await downscaleDataUrl(screenRes.image) };
    }
    return ok(j(screenRes));
  },
  desktop_click: async (args) => {
    const res = await (window as any).electronAPI.desktopClick({
      x: Number(p(args, 'x', 'X') ?? 0),
      y: Number(p(args, 'y', 'Y') ?? 0),
      button: p(args, 'button', 'Button') ?? 'left',
      double: !!p(args, 'double', 'Double')
    });
    return ok(j(res));
  },
  desktop_drag: async (args) => {
    const res = await (window as any).electronAPI.desktopDrag({
      fromX: Number(p(args, 'from_x', 'fromX', 'FromX') ?? 0),
      fromY: Number(p(args, 'from_y', 'fromY', 'FromY') ?? 0),
      toX: Number(p(args, 'to_x', 'toX', 'ToX') ?? 0),
      toY: Number(p(args, 'to_y', 'toY', 'ToY') ?? 0)
    });
    return ok(j(res));
  },
  desktop_type: async (args) => {
    const res = await (window as any).electronAPI.desktopType(p(args, 'text', 'Text') ?? '');
    return ok(j(res));
  },
  desktop_hotkey: async (args) => {
    const keys = p(args, 'keys', 'Keys');
    if (!Array.isArray(keys) || keys.length === 0) throw new Error("desktop_hotkey requires 'keys'");
    const res = await (window as any).electronAPI.desktopHotkey({ keys: keys.map(String) });
    return ok(j(res));
  },

  // Legacy alias for old conversation replays
  browser_keystrokes: async (args) => ok(await browserKeystrokesLegacyRouter(args)),

  // Blocks until the user answers the inline prompt in the chat input.
  ask_user: async (args, ctx) => {
    const question = String(p(args, 'question', 'Question') || '').trim();
    if (!question) throw new Error("ask_user requires 'question'");
    const rawOpts = p(args, 'options', 'Options', 'Option');
    // Free-text ("Write your own response") is always available in the UI, so
    // even a single option like "Proceed" is a valid prompt.
    const options = Array.isArray(rawOpts)
      ? rawOpts.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 8)
      : [];
    if (options.length === 0) {
      throw new Error(
        'ask_user requires at least one CONCRETE answer option (e.g. ["Proceed"]). ' +
        'Free-text is always available to the user additionally. Retry with real options.'
      );
    }
    const detail = p(args, 'detail', 'Detail');
    const response = await userPromptStore.enqueue({
      kind: 'ask',
      title: question,
      detail: detail ? String(detail) : undefined,
      options
    }, ctx.promptTaskId);
    if (response === null) return ok('No response — the prompt was dismissed. Continue without waiting or try a different approach.');
    return ok(`USER RESPONSE: ${response}`);
  },
};

// ─── Execution engine ────────────────────────────────────────────────────────

const runOne = async (raw: string, ctx: ToolContext): Promise<NamedToolResult> => {
  const { name, args } = parseToolCall(raw);
  try {
    const handler = HANDLERS[name];
    if (!handler) return { toolName: name, result: `Unknown tool: ${name}`, error: true };

    if (TOOL_TIERS[name] === 'confirm') {
      let approved = false;
      let denyMessage = '';
      try {
        const decision = await ctx.requestApproval(name, summarizeArgs(name, args));
        approved = decision.approved;
        denyMessage = decision.message || '';
      } catch {}
      if (!approved || ctx.signal?.aborted) {
        return {
          toolName: name,
          result: `USER DENIED PERMISSION for ${name}.${denyMessage ? ` User says: "${denyMessage}" —` : ''} Do not silently retry the same call — adapt your approach or explain to the user.`,
          error: true
        };
      }
    }

    // The user killed the Live Browser mid-task — short-circuit this webview
    // call with an explanation instead of silently operating on a blank page.
    if ((name.startsWith('browser') || name === 'find_in_page') && agentBrowserStore.consumeUserKill()) {
      return {
        toolName: name,
        result: 'USER ACTION: the user terminated the embedded browser while you were working. All pages were closed and the session reset to blank. If you still need web access, start over with browser_navigate.',
        error: true
      };
    }

    // Browsing resumed after a terminated session — drop the grayscale
    // snapshot so the live (remounted) webview shows through again.
    if ((name.startsWith('browser') || name === 'find_in_page') && agentBrowserStore.getTerminatedSnapshot()) {
      agentBrowserStore.setTerminatedSnapshot(null);
    }

    // Browser calls route to the acting agent's own tab. Per-tab locks guarantee
    // no two handlers for the same tab overlap, while different tabs run in
    // parallel. The module-level actor pointer is safe because same-tab calls
    // are serialized.
    const isBrowserTool = name.startsWith('browser') || name === 'find_in_page';
    if (isBrowserTool) setBrowserActor(ctx.agentId ?? null);
    if (isBrowserTool) agentBrowserStore.markActorBusy(ctx.agentId, true);

    const out = await handler(args, ctx);

    if (isBrowserTool) {
      setBrowserActor(null);
      agentBrowserStore.markActorBusy(ctx.agentId, false);
    }
    return { toolName: name, ...out };
  } catch (e: any) {
    setBrowserActor(null);
    agentBrowserStore.markActorBusy((ctx as any)?.agentId, false);
    return { toolName: name, result: `Execution error: ${e?.message || e}`, error: true };
  }
};

// Module-global chains ensure ordering is honored even when two concurrent
// executeToolCalls target the same tab (e.g. orchestrator + sub-agent on user tab).
const globalChains = new Map<string, Promise<void>>();

// Executes a batch of tool calls. Independent calls run concurrently;
// per-tab browser locks allow true parallelism across agents (each tab is a
// separate WebContentsView at OFFSCREEN_BOUNDS).
export const executeToolCalls = async (rawCalls: string[], ctx: ToolContext): Promise<NamedToolResult[]> => {
  const results: NamedToolResult[] = new Array(rawCalls.length);
  const localChains = new Map<string, Promise<void>>();

  await Promise.all(rawCalls.map((raw, idx) => {
    const { name } = parseToolCall(raw);
    const key = lockKeyFor(name, ctx);
    const job = () => runOne(raw, ctx).then(r => { results[idx] = r; });
    if (!key) return job();
    // Chain on both local batch order and global cross-batch order
    const prevLocal = localChains.get(key) ?? Promise.resolve();
    const prevGlobal = globalChains.get(key) ?? Promise.resolve();
    const prev = Promise.all([prevLocal, prevGlobal]).then(() => {});
    const next = prev.then(job, job);
    localChains.set(key, next);
    globalChains.set(key, next);
    const cleanup = () => { if (globalChains.get(key) === next) globalChains.delete(key); };
    next.then(cleanup, cleanup);
    return next;
  }));

  return results;
};

// Single-call convenience wrapper.
export const executeToolCall = (toolCallRaw: string, ctx: ToolContext): Promise<NamedToolResult> =>
  executeToolCalls([toolCallRaw], ctx).then(r => r[0]);
