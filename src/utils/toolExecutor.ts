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
import { agentBrowserStore } from './agentBrowserStore';
import {
  getWebSearchSettings,
  downscaleDataUrl,
  getModelSettings,
  applySettingsUpdate,
  fetchModels,
  getModelStats,
  primeModel,
  getProviders,
  LLMModel
} from './llm';
import { TOOL_TIERS } from './tools';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ToolResult {
  result: string;
  imageDataUrl?: string;
  error?: boolean;
}

export interface NamedToolResult extends ToolResult {
  toolName: string;
}

// Capabilities the executor needs from its host (ChatArea orchestrator or a
// sub-agent runner). Keeps this module free of React/state imports.
export interface ToolContext {
  getModel: () => LLMModel | null;
  setModel: (model: LLMModel) => void;
  requestApproval: (toolName: string, summary: string) => Promise<boolean>;
  spawnAgent: (spec: any) => string;
  getAgents: (ids?: string[]) => any[];
  waitForAgents: (ids: string[] | undefined, ms: number) => Promise<any[]>;
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

// Tools sharing one physical resource serialize through per-class chains:
// every browser_* tool drives the single embedded webview, desktop_* tools
// drive the one real mouse/keyboard. Everything else runs fully parallel.
const lockClassFor = (name: string): string | null =>
  name.startsWith('browser') || name === 'find_in_page' ? 'browser'
    : name.startsWith('desktop') ? 'desktop'
      : null;

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
        note: obs.markers.length > 0 ? 'Red numbered badges are Set-of-Mark IDs — use them with browser_click/browser_type etc.' : undefined
      }),
      imageDataUrl: await downscaleDataUrl(obs.image)
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
      imageDataUrl: await downscaleDataUrl(shot.image)
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

  // Self-modification (approval-gated upstream)
  list_models: async () => {
    const models = await fetchModels();
    const byProvider: Record<string, string[]> = {};
    for (const m of models) {
      (byProvider[m.provider] ||= []).push(m.id);
    }
    const enabledProviders = getProviders().filter(pr => pr.enabled).map(pr => pr.id);
    return ok(j({
      providers: enabledProviders.map(id => ({ id, models: (byProvider[id] || []).sort() })),
      hint: 'Pass model (+ optional provider) to switch_model.'
    }));
  },
  get_settings: async () => ok(j(getModelSettings())),
  get_model_stats: async (_args, ctx) => ok(j(await getModelStats(ctx.getModel()))),
  switch_model: async (args, ctx) => {
    const wantedId = String(p(args, 'model', 'Model') ?? '').trim();
    const wantedProvider = p(args, 'provider', 'Provider');
    if (!wantedId) throw new Error("switch_model requires 'model'");
    const models = await fetchModels();
    let match = models.find(m => m.id === wantedId && (!wantedProvider || m.provider === wantedProvider))
      || models.find(m => m.id.toLowerCase() === wantedId.toLowerCase() && (!wantedProvider || m.provider === wantedProvider));
    if (!match) {
      const suggestions = models.map(m => `${m.provider}/${m.id}`).slice(0, 40).join('\n');
      throw new Error(`Model "${wantedId}" not found. Available models:\n${suggestions}`);
    }
    ctx.setModel(match);
    // Best-effort warm-up so the next round starts fast.
    primeModel(match).catch(() => {});
    return ok(j({ success: true, switchedTo: { id: match.id, provider: match.provider }, note: 'Applies from the next reasoning step.' }));
  },
  update_settings: async (args) => {
    const { applied, rejected } = applySettingsUpdate(args);
    return ok(j({
      success: rejected.length === 0,
      applied,
      rejectedKeys: rejected.length > 0 ? rejected : undefined,
      settings: getModelSettings()
    }));
  },

  // Sub-agents
  spawn_agent: async (args, ctx) => {
    const task = p(args, 'task', 'Task');
    if (!task || !String(task).trim()) throw new Error("spawn_agent requires 'task'");
    const rawParams = args.params || args.Params || {};
    const spec = {
      task: String(task),
      tools: p(args, 'tools', 'Tools'),
      context: p(args, 'context', 'Context'),
      label: p(args, 'label', 'Label'),
      model: args.model || args.Model
        ? { id: String(args.model || args.Model), provider: p(args, 'provider', 'Provider') }
        : undefined,
      params: {
        temperature: rawParams.temperature,
        topP: rawParams.top_p ?? rawParams.topP,
        thinkingLevel: rawParams.thinking_level ?? rawParams.thinkingLevel,
        maxOutputLength: rawParams.max_output_length ?? rawParams.maxOutputLength,
        contextWindow: rawParams.context_window ?? rawParams.contextWindow
      }
    };
    const agentId = ctx.spawnAgent(spec);
    const waitMs = Number(p(args, 'wait_ms', 'waitMs')) || 0;
    if (waitMs > 0) {
      const states = await ctx.waitForAgents([agentId], waitMs);
      return ok(j({ agent_id: agentId, states }));
    }
    return ok(j({ agent_id: agentId, status: 'spawned', note: `Poll with check_agents(agent_ids=["${agentId}"]).` }));
  },
  check_agents: async (args, ctx) => {
    const ids = p(args, 'agent_ids', 'agentIds', 'ids');
    const waitMs = Number(p(args, 'wait_ms', 'waitMs')) || 0;
    const normIds = Array.isArray(ids) ? ids.map(String) : undefined;
    const states = waitMs > 0
      ? await ctx.waitForAgents(normIds, waitMs)
      : ctx.getAgents(normIds);
    return ok(j({ agents: states }));
  },

  // Legacy alias for old conversation replays
  browser_keystrokes: async (args) => ok(await browserKeystrokesLegacyRouter(args))
};

// ─── Execution engine ────────────────────────────────────────────────────────

const runOne = async (raw: string, ctx: ToolContext): Promise<NamedToolResult> => {
  const { name, args } = parseToolCall(raw);
  try {
    const handler = HANDLERS[name];
    if (!handler) return { toolName: name, result: `Unknown tool: ${name}`, error: true };

    if (TOOL_TIERS[name] === 'confirm') {
      let approved = false;
      try {
        approved = await ctx.requestApproval(name, summarizeArgs(name, args));
      } catch {}
      if (!approved || ctx.signal?.aborted) {
        return {
          toolName: name,
          result: `USER DENIED PERMISSION for ${name}. Do not silently retry the same call — adapt your approach or explain to the user.`,
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

    const out = await handler(args, ctx);
    return { toolName: name, ...out };
  } catch (e: any) {
    return { toolName: name, result: `Execution error: ${e?.message || e}`, error: true };
  }
};

// Executes a batch of tool calls. Independent calls run concurrently;
// browser/desktop calls are serialized in arrival order through shared locks
// (also honored across sub-agents, since the lock map is module-global).
export const executeToolCalls = async (rawCalls: string[], ctx: ToolContext): Promise<NamedToolResult[]> => {
  const results: NamedToolResult[] = new Array(rawCalls.length);
  const chains = new Map<string, Promise<void>>();

  await Promise.all(rawCalls.map((raw, idx) => {
    const { name } = parseToolCall(raw);
    const cls = lockClassFor(name);
    const job = () => runOne(raw, ctx).then(r => { results[idx] = r; });
    if (!cls) return job();
    const prev = chains.get(cls) ?? Promise.resolve();
    const next = prev.then(job, job);
    chains.set(cls, next);
    return next;
  }));

  return results;
};

// Single-call convenience wrapper.
export const executeToolCall = (toolCallRaw: string, ctx: ToolContext): Promise<NamedToolResult> =>
  executeToolCalls([toolCallRaw], ctx).then(r => r[0]);
