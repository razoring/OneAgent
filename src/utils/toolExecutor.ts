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
import {
  getWebSearchSettings,
  downscaleDataUrl,
  getModelSettings,
  applySettingsUpdate,
  fetchModels,
  getModelStats,
  getVramReport,
  estimateModelVram,
  primeModel,
  getProviders,
  LLMModel
} from './llm';
import { TOOL_TIERS } from './tools';
import { userPromptStore } from './userPromptStore';
import { taskListStore } from './taskListStore';
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

// Capabilities the executor needs from its host (ChatArea orchestrator or a
// sub-agent runner). Keeps this module free of React/state imports.
export interface ToolContext {
  getModel: () => LLMModel | null;
  setModel: (model: LLMModel) => void;
  requestApproval: (toolName: string, summary: string) => Promise<{ approved: boolean; message?: string }>;
  spawnAgent: (spec: any) => string;
  getAgents: (ids?: string[]) => any[];
  waitForAgents: (ids: string[] | undefined, ms: number) => Promise<any[]>;
  // When set, ask_user prompts flip this formal task's needsInput flag.
  promptTaskId?: string;
  // The calling sub-agent's own bound task id — complete_task can ONLY mark
  // this one task done, never anyone else's.
  ownTaskId?: string;
  // Acting sub-agent id — routes browser_* calls to this agent's OWN tab.
  agentId?: string;
  // Latest user annotations on the assistant reply — delivered together with
  // an ask_user answer so the model acts on them in-flow.
  getAnnotations?: () => { quote: string; text: string }[];
  // Cross-round orchestration gates (ChatArea supplies one shared object per
  // generation; sub-agents omit it and are never gated).
  gate?: {
    // Set once list_models succeeds — spawn_agent/task_add refuse otherwise.
    modelsListed?: boolean;
  };
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

// Human-readable GB formatter for VRAM warnings.
const fmtGb = (b: number) => (b >= 1024 * 1024 * 1024 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${Math.round(b / 2 ** 20)} MB`);

// VRAM budget check for a candidate model. `excludeModelId` frees its
// footprint first (switch_model replaces the resident model). Returns a
// warning string when the model would force evictions, else undefined.
const vramFitCheck = async (modelId: string, excludeModelId?: string): Promise<string | undefined> => {
  try {
    const report = await getVramReport();
    if (!report.supported || report.headroomBytes == null) return undefined;
    let headroom = report.headroomBytes;
    if (excludeModelId) {
      const key = excludeModelId.toLowerCase();
      for (const models of Object.values(report.loadedModels)) {
        const hit = models.find(m => String(m.id).toLowerCase() === key);
        if (hit?.vramBytes != null) headroom += hit.vramBytes;
      }
    }
    const need = estimateModelVram(modelId, report);
    if (need != null && need > headroom) {
      return `VRAM: "${modelId}" needs ~${fmtGb(need)} but only ~${fmtGb(headroom)} is available — loading it will evict resident model(s) (possibly YOU, forcing a slow reload on your next step). Pick a model within this budget; your own model id is always safe.`;
    }
  } catch { /* diagnostics are best-effort */ }
  return undefined;
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

  // Self-modification (approval-gated upstream)
  list_models: async (_args, ctx) => {
    const [models, report] = await Promise.all([fetchModels(), getVramReport()]);
    const activeId = String(ctx.getModel()?.id || '').toLowerCase();
    // Local providers only: keys exist even when zero models are loaded.
    const localProviderIds = new Set(Object.keys(report.loadedModels));
    const gb = (b?: number) => (b == null ? '?' : `${(b / 2 ** 30).toFixed(1)}GB`);

    const lines: string[] = [];
    if (report.totalBytes != null) {
      lines.push(`VRAM: ${gb(report.usedBytes)} used / ${gb(report.totalBytes)} total (${gb(report.headroomBytes)} free)`);
      lines.push('');
    }

    const enabledProviders = getProviders().filter(pr => pr.enabled).map(pr => pr.id);
    let filteredOut = 0;
    for (const pid of enabledProviders) {
      const isLocal = localProviderIds.has(pid);
      const providerModels = models.filter(m => m.provider === pid);
      if (providerModels.length === 0) continue;
      lines.push(`${pid}${isLocal ? '' : ' (cloud)'}:`);
      for (const m of providerModels.sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
        if (!isLocal) { lines.push(`  - ${m.id}`); continue; }
        const est = estimateModelVram(m.id, report);
        const isCurrent = String(m.id).toLowerCase() === activeId;
        // VRAM gate: hide local models that cannot load without evicting
        // resident models. The CURRENT model is always listed.
        if (est != null && report.headroomBytes != null && est > report.headroomBytes && !isCurrent) {
          filteredOut++;
          continue;
        }
        const loaded = Object.values(report.loadedModels)
          .some(list => list.some(l => String(l.id).toLowerCase() === m.id.toLowerCase()));
        const tags: string[] = [];
        if (isCurrent) tags.push('YOUR CURRENT MODEL');
        else if (loaded) tags.push('loaded');
        if (est != null) tags.push(`~${gb(est)} VRAM`);
        lines.push(`  - ${m.id} (${tags.join(', ')})`);
      }
    }
    if (filteredOut > 0) {
      lines.push('');
      lines.push(`[${filteredOut} installed local model(s) hidden — they exceed the ${gb(report.headroomBytes)} free VRAM and spawn_agent would reject them.]`);
    }
    lines.push('');
    lines.push('Pass one of these ids as `model` to switch_model or spawn_agent. Omitting `model` in spawn_agent inherits YOUR current model (zero VRAM cost).');

    return ok(lines.join('\n'));
  },
  get_settings: async () => ok(j(getModelSettings())),
  get_model_stats: async (_args, ctx) => ok(j(await getModelStats(ctx.getModel()))),
  // Workers check off their OWN bound task — the orchestrator never sees a
  // task go 'done' just because an agent's loop ended (or was stopped).
  complete_task: async (args, ctx) => {
    if (!ctx.ownTaskId) throw new Error("complete_task is only available to sub-agents bound to a formal task");
    const summary = String(p(args, 'summary', 'Summary') ?? '').trim();
    if (!summary) throw new Error("complete_task requires 'summary'");
    const task = taskListStore.find(ctx.ownTaskId);
    if (!task) throw new Error('Your bound task no longer exists');
    if (task.status === 'done') return ok(j({ success: true, note: 'Task was already checked off.' }));
    taskListStore.update(ctx.ownTaskId, { status: 'done', endedAt: Date.now(), resultSummary: summary.slice(0, 160) });
    return ok(j({ success: true, task_id: ctx.ownTaskId, status: 'done' }));
  },
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
    // Switching frees the current model's footprint but the new one must
    // still fit in what remains — warn instead of silently thrashing.
    const vramWarning = await vramFitCheck(match.id, ctx.getModel()?.id);
    return ok(j({
      success: true,
      switchedTo: { id: match.id, provider: match.provider },
      ...(vramWarning ? { warning: vramWarning } : {}),
      note: 'Applies from the next reasoning step.'
    }));
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
    // Small models frequently put the instructions in `context` (or `label`)
    // instead of the required `task` field — coerce rather than fail the spawn.
    let task = p(args, 'task', 'Task');
    let context = p(args, 'context', 'Context');
    const hasTask = !!(task && String(task).trim());
    if (!hasTask && context && String(context).trim()) {
      task = context;
      context = undefined;
    } else if (!hasTask) {
      task = p(args, 'label', 'Label');
    }
    if (!task || !String(task).trim()) {
      throw new Error("spawn_agent requires 'task' — the full self-contained instructions for the sub-agent");
    }
    const rawParams = args.params || args.Params || {};
    const spec = {
      task: String(task),
      tools: p(args, 'tools', 'Tools'),
      context,
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
      },
      taskId: (p(args, 'task_id', 'taskId') || undefined) as string | undefined,
      canDelegate: !!(p(args, 'can_delegate', 'canDelegate'))
    };
    // Hard VRAM gate BEFORE spawning: an oversized sub-agent model would
    // evict resident models (possibly the orchestrator itself).
    if (ctx.gate && !ctx.gate.modelsListed) {
      throw new Error("spawn_agent is gated: call list_models first (it shows which models fit the available VRAM), then spawn.");
    }
    if (spec.model?.id) {
      const overBudget = await vramFitCheck(String(spec.model.id));
      if (overBudget) {
        throw new Error(`${overBudget}\nspawn_agent refused. Omit 'model' to inherit your own (already loaded), or pick one from list_models — every model listed there fits.`);
      }
    }
    // Duplicate spawn guard: an agent already bound to this task means the
    // model repeated the call — return the existing agent instead of spawning
    // a twin that would fight over the same task.
    const alreadyBound = spec.taskId ? taskListStore.find(spec.taskId)?.agentId : undefined;
    if (alreadyBound) {
      return ok(j({
        agent_id: alreadyBound,
        status: 'already_spawned',
        note: `An agent is already bound to task "${spec.taskId}". Do NOT spawn it again — poll check_agents.`
      }));
    }
    const agentId = ctx.spawnAgent(spec);
    if (spec.taskId && !taskListStore.find(spec.taskId)) {
      return ok(j({ agent_id: agentId, status: 'spawned', warning: `task_id "${spec.taskId}" not found — use task_list for valid ids.` }));
    }
    const waitMs = Number(p(args, 'wait_ms', 'waitMs')) || 0;
    if (waitMs > 0) {
      const states = await ctx.waitForAgents([agentId], waitMs);
      return ok(j({ agent_id: agentId, states }));
    }
    return ok(j({ agent_id: agentId, status: 'spawned', note: `Poll with check_agents(agent_ids=["${agentId}"]).` }));
  },

  // ── Formal task tree ───────────────────────────────────────────────────────
  task_add: async (args, ctx) => {
    if (ctx.gate && !ctx.gate.modelsListed) {
      throw new Error("task_add is gated: call list_models first, then create tasks.");
    }
    // Models occasionally singularize the key ("item") — accept both.
    const raw = p(args, 'items', 'item', 'Items', 'Item');
    const parentId = (p(args, 'parent_id', 'parentId') || null) as string | null;
    let items = Array.isArray(raw) ? raw : null;
    if (!items && (args.title || args.Title)) {
      items = [{ title: String(p(args, 'title', 'Title')), detail: p(args, 'detail', 'Detail') }];
    }
    if (!items || items.length === 0) throw new Error("task_add requires 'items' ([{title, detail?}]) or 'title'");
    if (parentId && !taskListStore.find(parentId)) throw new Error(`task_add: parent_id "${parentId}" not found`);
    // Models retry/repeat batches — silently skip titles that already exist.
    const existingTitles = new Set(taskListStore.get().map(n => n.title.toLowerCase()));
    const skipped: string[] = [];
    items = items.filter((it: any) => {
      const t = String(it?.title ?? '').trim().toLowerCase();
      if (!t) return false;
      if (existingTitles.has(t)) { skipped.push(String(it?.title ?? '').trim()); return false; }
      existingTitles.add(t);
      return true;
    });
    if (items.length === 0) {
      return ok(j({ created: [], skipped, note: 'All requested tasks already exist.' }));
    }
    const created = taskListStore.add(
      items.map((it: any) => ({ title: String(it?.title ?? ''), detail: it?.detail ? String(it.detail) : undefined })),
      parentId
    );
    return ok(j({ created: created.map(n => ({ id: n.id, title: n.title })), ...(skipped.length ? { skippedDuplicates: skipped } : {}) }));
  },

  task_update: async (args) => {
    const id = String(p(args, 'task_id', 'taskId', 'id', 'Id') || '');
    if (!id) throw new Error("task_update requires 'task_id'");
    if (!taskListStore.find(id)) throw new Error(`task_update: task "${id}" not found`);
    const status = p(args, 'status', 'Status');
    const summary = p(args, 'summary', 'Summary');
    const patch: any = {};
    if (status) {
      const s = String(status);
      if (!['queued', 'running', 'done', 'error', 'review'].includes(s)) throw new Error(`task_update: invalid status "${s}"`);
      patch.status = s;
      if (s === 'done' || s === 'error') patch.endedAt = Date.now();
    }
    if (summary) patch.resultSummary = String(summary).slice(0, 200);
    taskListStore.update(id, patch);
    return ok(j({ updated: id, ...patch }));
  },

  task_list: async () => ok(j({ tasks: taskListStore.get(), progress: taskListStore.leafProgress() })),

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
    // Inline annotations the user made on the reply travel with the answer.
    let annotations = '';
    try {
      const notes = ctx.getAnnotations?.() || [];
      if (notes.length > 0) {
        annotations = '\n\nUser inline annotations on your reply (apply them):\n' +
          notes.slice(0, 20).map(c => `- On "${String(c.quote).slice(0, 100)}": ${c.text}`).join('\n');
      }
    } catch {}
    return ok(`USER RESPONSE: ${response}${annotations}`);
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

    // Browser calls route to the acting agent's own tab. The global browser
    // lock guarantees no two browser handlers overlap, so the module-level
    // actor pointer can never be crossed mid-handler.
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
