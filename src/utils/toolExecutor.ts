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
import { cdpBrowserStore } from './cdpBrowserStore';
import * as cdpTools from './cdpTools';
import { TOOL_TIERS } from './tools';
import { userPromptStore } from './userPromptStore';

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
  // Active chat for per-chat task isolation.
  chatId?: string | null;
  // Inline annotations on the assistant reply — delivered with ask_user answers.
  getAnnotations?: () => { quote: string; text: string }[];
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

// CDP live-profile check — cached to avoid IPC storm. Refreshed on demand.
let _cdpLastCheck = 0;
let _cdpCached = false;
const isCdpMode = async (): Promise<boolean> => {
  const now = Date.now();
  if (now - _cdpLastCheck < 1500) return _cdpCached;
  _cdpLastCheck = now;
  try {
    const api: any = (window as any).electronAPI;
    if (!api?.chromeStatus) { _cdpCached = false; return false; }
    const port = 9222;
    const r = await api.chromeStatus();
    _cdpCached = !!r?.listening;
    return _cdpCached;
  } catch { _cdpCached = false; return false; }
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

// CDP live-profile: each agent gets its own Target (page) in the shared
// Chromium profile, so browser_* can run truly parallel per-agent. Fallback
// webview is single-view and serializes. Desktop remains global.
const lockKeyFor = (name: string, ctx: ToolContext): string | null => {
  if (name.startsWith('browser') || name === 'find_in_page') {
    return `browser:${(ctx as any).agentId ?? (ctx as any).currentActor ?? '__user__'}`;
  }
  if (name.startsWith('desktop')) return 'desktop';
  return null;
};
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

  // Embedded browser — navigation & observation (CDP live-profile when Browser was launched, else fallback to embedded webview)
  browser_navigate: async (args, ctx) => {
    let url: string = String(p(args, 'url', 'Url') ?? '').trim() || 'https://html.duckduckgo.com';
    if (!/^https?:\/\//i.test(url)) {
      if (url.includes('.') && !url.includes(' ')) url = 'https://' + url;
      else url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(url);
    }
    if (await isCdpMode()) {
      try { return ok(await cdpTools.cdpNavigate(((ctx as any).agentId ?? null), url)); } catch (e: any) { /* fallback */ }
    }
    return ok(await executeBrowserNavigation('navigate', url));
  },
  browser_go_back: async (_a, ctx) => {
    if (await isCdpMode()) {
      try {
        const t = await cdpBrowserStore.ensureTarget(((ctx as any).agentId ?? null));
        const api: any = (window as any).electronAPI;
        const r = await api.cdpSend({ webContentsId: Number(t.id), method: 'Page.goBack', params: {} });
        if (r?.success) return ok('OK');
      } catch {}
    }
    return ok(await executeBrowserNavigation('back'));
  },
  browser_terminate: async (_a, ctx) => {
    if (await isCdpMode()) {
      try {
        const agentId = ((ctx as any).agentId ?? null);
        const t = cdpBrowserStore.getTargetForAgent(agentId);
        if (t) {
          const api: any = (window as any).electronAPI;
          await api.destroyAgentBrowser(agentId).catch(()=>{});
          cdpBrowserStore.removeByAgent(agentId);
          return ok('Browser terminated (Agent browser closed). Next navigate will create fresh target.');
        }
      } catch {}
    }
    return ok(await executeBrowserTerminate());
  },
  browser_get_dom: async (_a, ctx) => {
    if (await isCdpMode()) {
      try { return ok(await cdpTools.cdpGetDom(((ctx as any).agentId ?? null))); } catch {}
    }
    return ok(await getSemanticDOM());
  },
  browser_observe: async (_a, ctx) => {
    if (await isCdpMode()) {
      try {
        const obs = await cdpTools.cdpObserve(((ctx as any).agentId ?? null));
        return {
          result: j({
            success: true,
            image: 'Annotated browser screenshot attached to this tool response (CDP live-profile target).',
            elements: obs.markers.length > 0 ? obs.markers : undefined,
            dom: obs.dom.length > 0 ? obs.dom : undefined,
            meta: obs.meta && Object.keys(obs.meta).length > 0 ? obs.meta : undefined,
            note: obs.markers.length > 0 ? 'CDP Target — numbered badges are SoM IDs — use with browser_click/browser_type etc.' : undefined
          }),
          imageDataUrl: await downscaleDataUrl(obs.image, 1280, 0.92)
        };
      } catch (e: any) {
        // fallback to webview
      }
    }
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
  browser_screenshot: async (_a, ctx) => {
    if (await isCdpMode()) {
      try {
        const { image, markers } = await cdpTools.cdpCaptureWithSoM(((ctx as any).agentId ?? null));
        return {
          result: j({
            success: true,
            image: 'Screenshot of the CDP browser viewport attached to this tool response.',
            elements: markers.length > 0 ? markers : undefined
          }),
          imageDataUrl: await downscaleDataUrl(image, 1280, 0.92)
        };
      } catch {}
    }
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

  // Embedded browser — virtual input primitives (CDP live-profile when Browser launched)
  browser_click: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const id = p(args,'id'); const x=p(args,'x'); const y=p(args,'y');
        const button = p(args,'button')||'left'; const clickCount = Number(p(args,'click_count')||1);
        const res = await cdpTools.cdpClick(((ctx as any).agentId ?? null), id!=null?Number(id):undefined, x!=null?Number(x):undefined, y!=null?Number(y):undefined, button, clickCount);
        return ok(res);
      } catch {}
    }
    return ok(await browserClick(args));
  },
  browser_mouse_down: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const id=p(args,'id'); const x=p(args,'x'); const y=p(args,'y'); const button=p(args,'button')||'left';
        const act=((ctx as any).agentId ?? null); const {target}=await (await import('./cdpBrowserStore')).cdpBrowserStore.ensureTarget(act) as any;
        let px=x, py=y;
        if (id!=null) {
          const js=`(function(){const el=window.__oneagentElements&&window.__oneagentElements[${Number(id)}]; if(!el)return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
          const api:any=(window as any).electronAPI; const r=await api.cdpSend({webContentsId:Number(target.id),method:'Runtime.evaluate',params:{expression:js,returnByValue:true}}); const v=r?.result?.result?.value ?? r?.result?.value ?? r?.result; if(v&&typeof v.x==='number'){px=v.x;py=v.y;} else return ok(`Element ${id} not found — take a browser_observe to re-label`);
        }
        const api:any=(window as any).electronAPI; await api.cdpSend({webContentsId:Number(target.id),method:'Input.dispatchMouseEvent',params:{type:'mousePressed',x:px,y:py,button,clickCount:1}});
        return ok(`Mouse down ${id!=null?`element ${id}`:`at (${px},${py})`}`);
      } catch {}
    }
    return ok(await browserHold(args, 'down'));
  },
  browser_mouse_up: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const id=p(args,'id'); const x=p(args,'x'); const y=p(args,'y'); const button=p(args,'button')||'left';
        const act=((ctx as any).agentId ?? null); const {target}=await (await import('./cdpBrowserStore')).cdpBrowserStore.ensureTarget(act) as any;
        let px=x, py=y;
        if (id!=null) {
          const js=`(function(){const el=window.__oneagentElements&&window.__oneagentElements[${Number(id)}]; if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
          const api:any=(window as any).electronAPI; const r=await api.cdpSend({webContentsId:Number(target.id),method:'Runtime.evaluate',params:{expression:js,returnByValue:true}}); const v=r?.result?.result?.value ?? r?.result?.value ?? r?.result; if(v) {px=v.x;py=v.y;}
        }
        if (px==null) px=0; if (py==null) py=0;
        const api:any=(window as any).electronAPI; await api.cdpSend({webContentsId:Number(target.id),method:'Input.dispatchMouseEvent',params:{type:'mouseReleased',x:px,y:py,button,clickCount:1}});
        return ok(`Mouse up ${id!=null?`element ${id}`:`at (${px},${py})`}`);
      } catch {}
    }
    return ok(await browserHold(args, 'up'));
  },
  browser_mouse_move: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const id=p(args,'id'); const x=p(args,'x'); const y=p(args,'y');
        const act=((ctx as any).agentId ?? null); const {target}=await (await import('./cdpBrowserStore')).cdpBrowserStore.ensureTarget(act) as any;
        let px=x, py=y;
        if (id!=null) {
          const js=`(function(){const el=window.__oneagentElements&&window.__oneagentElements[${Number(id)}]; if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
          const api:any=(window as any).electronAPI; const r=await api.cdpSend({webContentsId:Number(target.id),method:'Runtime.evaluate',params:{expression:js,returnByValue:true}}); const v=r?.result?.result?.value ?? r?.result?.value ?? r?.result; if(v) {px=v.x;py=v.y;}
        }
        if (px==null||py==null) return ok('Target not found — provide id or x/y');
        const api:any=(window as any).electronAPI; await api.cdpSend({webContentsId:Number(target.id),method:'Input.dispatchMouseEvent',params:{type:'mouseMoved',x:px,y:py}});
        return ok(`Mouse moved to (${px},${py})`);
      } catch {}
    }
    return ok(await browserMove(args));
  },
  browser_drag: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const fi=p(args,'from_id'); const fx=p(args,'from_x'); const fy=p(args,'from_y');
        const ti=p(args,'to_id'); const tx=p(args,'to_x'); const ty=p(args,'to_y');
        const button=p(args,'button')||'left';
        const act=((ctx as any).agentId ?? null); const {target}=await (await import('./cdpBrowserStore')).cdpBrowserStore.ensureTarget(act) as any;
        const api:any=(window as any).electronAPI;
        let sx:any=fx, sy:any=fy;
        if (fi!=null) {
          const js=`(function(){const el=window.__oneagentElements&&window.__oneagentElements[${Number(fi)}]; if(!el)return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
          const r=await api.cdpSend({webContentsId:Number(target.id),method:'Runtime.evaluate',params:{expression:js,returnByValue:true}}); const v=r?.result?.result?.value ?? r?.result?.value ?? r?.result; if(v){sx=v.x;sy=v.y;}
        }
        let ex:any=tx, ey:any=ty;
        if (ti!=null) {
          const js=`(function(){const el=window.__oneagentElements&&window.__oneagentElements[${Number(ti)}]; if(!el)return null; const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`;
          const r=await api.cdpSend({webContentsId:Number(target.id),method:'Runtime.evaluate',params:{expression:js,returnByValue:true}}); const v=r?.result?.result?.value ?? r?.result?.value ?? r?.result; if(v){ex=v.x;ey=v.y;}
        }
        if (sx==null||sy==null||ex==null||ey==null) return ok('Drag requires source and destination');
        await api.cdpSend({webContentsId:Number(target.id),method:'Input.dispatchMouseEvent',params:{type:'mousePressed',x:sx,y:sy,button,clickCount:1}});
        const steps=8;
        for(let i=1;i<=steps;i++){ const ix=Math.round(sx+(ex-sx)*i/steps), iy=Math.round(sy+(ey-sy)*i/steps); await api.cdpSend({webContentsId:Number(target.id),method:'Input.dispatchMouseEvent',params:{type:'mouseMoved',x:ix,y:iy}}); await new Promise(r=>setTimeout(r,16)); }
        await api.cdpSend({webContentsId:Number(target.id),method:'Input.dispatchMouseEvent',params:{type:'mouseReleased',x:ex,y:ey,button,clickCount:1}});
        return ok(`Dragged ${fi!=null?`#${fi}`:`(${fx},${fy})`} → ${ti!=null?`#${ti}`:`(${tx},${ty})`}`);
      } catch {}
    }
    return ok(await browserDragTo(args));
  },
  browser_key: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const key=String(p(args,'key')||''); const mods=p(args,'modifiers')||[]; const state=p(args,'state')||'press';
        const act=((ctx as any).agentId ?? null); const {target}=await (await import('./cdpBrowserStore')).cdpBrowserStore.ensureTarget(act) as any;
        const api:any=(window as any).electronAPI;
        const modMap:any={control:2, ctrl:2, alt:1, shift:8, meta:4, command:4};
        let modBits=0; for(const m of mods) modBits|=modMap[String(m).toLowerCase()]||0;
        if (state==='down' || state==='press') await api.cdpSend({webContentsId:Number(target.id),method:'Input.dispatchKeyEvent',params:{type:'keyDown', key, modifiers:modBits}});
        if (state==='up' || state==='press') { await new Promise(r=>setTimeout(r,30)); await api.cdpSend({webContentsId:Number(target.id),method:'Input.dispatchKeyEvent',params:{type:'keyUp', key, modifiers:modBits}}); }
        return ok(`Pressed ${key} ${mods.length?`+${mods.join('+')}`:''}`);
      } catch {}
    }
    return ok(await browserPressKey(args));
  },
  browser_type: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const text=String(p(args,'text')||''); if(!text) throw new Error("browser_type requires 'text'");
        const id=p(args,'id'); const submit=!!p(args,'submit');
        const res=await cdpTools.cdpType(((ctx as any).agentId ?? null), text, id!=null?Number(id):undefined, submit);
        return ok(res);
      } catch {}
    }
    return ok(await browserType(args));
  },
  browser_scroll: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const dir=String(p(args,'direction')||'down'); const amount=Number(p(args,'amount')||600); const id=p(args,'id');
        const res=await cdpTools.cdpScroll(((ctx as any).agentId ?? null), dir, amount, id!=null?Number(id):undefined);
        return ok(res);
      } catch {}
    }
    return ok(await browserScroll(args));
  },
  browser_fill_form: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const data = args.data || args.Data || {};
        const res = await cdpTools.cdpFillForm(((ctx as any).agentId ?? null), data);
        return ok(res);
      } catch (e: any) { return ok(`Error: ${e.message}`); }
    }
    return ok('Fallback not implemented');
  },
  browser_file_upload: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const id = Number(p(args,'id'));
        const files = p(args,'files') || [];
        const res = await cdpTools.cdpFileUpload(((ctx as any).agentId ?? null), id, files);
        return ok(res);
      } catch (e: any) { return ok(`Error: ${e.message}`); }
    }
    return ok('Fallback not implemented');
  },
  browser_console_messages: async (args, ctx) => {
    if (await isCdpMode()) {
      try { return ok(await cdpTools.cdpConsoleMessages(((ctx as any).agentId ?? null))); } catch (e: any) { return ok(`Error: ${e.message}`); }
    }
    return ok('Fallback not implemented');
  },
  browser_network_requests: async (args, ctx) => {
    if (await isCdpMode()) {
      try { return ok(await cdpTools.cdpNetworkRequests(((ctx as any).agentId ?? null))); } catch (e: any) { return ok(`Error: ${e.message}`); }
    }
    return ok('Fallback not implemented');
  },
  browser_handle_dialog: async (args, ctx) => {
    if (await isCdpMode()) {
      try {
        const accept = !!p(args,'accept');
        const promptText = p(args,'promptText');
        const res = await cdpTools.cdpHandleDialog(((ctx as any).agentId ?? null), accept, promptText);
        return ok(res);
      } catch (e: any) { return ok(`Error: ${e.message}`); }
    }
    return ok('Fallback not implemented');
  },

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

  // ── Persistent per-chat tasks (LLM-owned, not injected into history) ──
  // task_add REPLACES all tasks for this chat (clear-before-add), no hard limit.
  // task_list returns only active (queued/running) by default to avoid context bleed.
  task_add: async (args, ctx) => {
    const raw = p(args, 'tasks', 'Tasks', 'items', 'Items');
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("task_add requires 'tasks' array with at least one verbose task");
    const chatId = ctx.chatId;
    if (!chatId) throw new Error('task_add requires an active chat (no chatId in context)');
    const { taskStore } = await import('./taskStore');
    // Verbose validation — adaptive for small models (gemma:4b etc.) that struggle with verbosity
    const modelId = String(ctx.getModel?.()?.id || '').toLowerCase();
    const isSmall = /gemma|4b|2b|1b|mini|small/i.test(modelId) || modelId.includes('e4b');
    const descMin = isSmall ? 40 : 120;
    const ctxMin = isSmall ? 20 : 80;
    for (let i = 0; i < raw.length; i++) {
      const t: any = raw[i];
      const title = String(t.title || '').trim();
      const desc = String(t.description || t.detail || '').trim();
      const ctxStr = String(t.context || '').trim();
      const acc = t.acceptanceCriteria || t.acceptance || [];
      if (!title) throw new Error(`task_add: tasks[${i}].title is required (imperative ≤15 words)`);
      if (desc.length < descMin) throw new Error(`task_add: tasks[${i}].description must be verbose ≥${descMin} chars (why+how), got ${desc.length}. Rewrite more verbosely.`);
      if (ctxStr.length < ctxMin) throw new Error(`task_add: tasks[${i}].context must be ≥${ctxMin} chars verbatim (paths/commands/URLs), got ${ctxStr.length}. Include copy-paste ready context.`);
      if (!Array.isArray(acc) || acc.length < (isSmall ? 1 : 2)) throw new Error(`task_add: tasks[${i}].acceptanceCriteria requires ≥${isSmall?1:2} observable checkboxes, got ${Array.isArray(acc)?acc.length:0}`);
    }
    const items = raw.map((t: any) => ({
      title: String(t.title).trim(),
      description: String(t.description || t.detail || '').trim(),
      goal: String(t.goal || '').trim(),
      assumptions: Array.isArray(t.assumptions) ? t.assumptions.map((s:any)=>String(s)) : [],
      acceptanceCriteria: (t.acceptanceCriteria || t.acceptance || []).map((s:any)=>String(s)),
      toolHint: String(t.toolHint || t.tool || 'mixed') as any,
      context: String(t.context || '').trim(),
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map((s:any)=>String(s)) : [],
    }));
    const created = taskStore.replaceAll(chatId, items);
    return ok(j({ success: true, clearedPrevious: true, created: created.map(c=>({id:c.id, title:c.title, status:c.status})), note: 'Replaced all tasks for this chat (previous cleared). Update each via task_update when acceptance met.' }));
  },

  task_update: async (args, ctx) => {
    const taskId = String(p(args, 'taskId', 'task_id', 'id') || '').trim();
    const status = String(p(args, 'status') || '').trim() as any;
    const resultSummary = p(args, 'resultSummary', 'result_summary', 'summary');
    if (!taskId) throw new Error("task_update requires 'taskId'");
    if (!['queued','running','done','error'].includes(status)) throw new Error(`task_update: status must be 'queued'|'running'|'done'|'error', got '${status}'`);
    const chatId = ctx.chatId;
    if (!chatId) throw new Error('task_update requires an active chat');
    const { taskStore } = await import('./taskStore');
    const updated = taskStore.update(chatId, taskId, { status, ...(resultSummary!==undefined?{resultSummary:String(resultSummary).slice(0,400)}:{}) });
    if (!updated) throw new Error(`task_update: task '${taskId}' not found in chat '${chatId}' (did you call task_list? tasks are per-chat and cleared on task_add)`);
    if (status==='done' || status==='error') {
      if (!resultSummary || String(resultSummary).trim().length===0) throw new Error('task_update to done/error requires resultSummary (≤160c summary of what was accomplished)');
    }
    return ok(j({ success: true, task: { id: updated.id, title: updated.title, status: updated.status } }));
  },

  task_list: async (args, ctx) => {
    const chatId = ctx.chatId;
    if (!chatId) throw new Error('task_list requires an active chat');
    const { taskStore } = await import('./taskStore');
    const includeDone = !!p(args, 'includeDone', 'include_done');
    const list = includeDone ? taskStore.listAllForChat(chatId) : taskStore.listActive(chatId);
    return ok(j({ chatId, count: list.length, tasks: list.map(t=>({ id:t.id, title:t.title, description:t.description, goal:t.goal, assumptions:t.assumptions, acceptanceCriteria:t.acceptanceCriteria, toolHint:t.toolHint, context:t.context, dependsOn:t.dependsOn, status:t.status, updatedAt:t.updatedAt })) }));
  },

  // Legacy alias for old conversation replays
  browser_keystrokes: async (args) => ok(await browserKeystrokesLegacyRouter(args)),

  // Blocks until the user answers the inline prompt in the chat input.
  ask_user: async (args, ctx) => {
    const question = String(p(args, 'question', 'Question') || '').trim();
    if (!question) throw new Error("ask_user requires 'question'");
    const rawOpts = p(args, 'options', 'Options', 'Option');
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
    });
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
    // snapshot overlay so the live webview shows through again.
    if ((name.startsWith('browser') || name === 'find_in_page') && agentBrowserStore.getTerminatedSnapshot()) {
      agentBrowserStore.setTerminatedSnapshot(null);
    }

    const out = await handler(args, ctx);
    return { toolName: name, ...out };
  } catch (e: any) {
    return { toolName: name, result: `Execution error: ${e?.message || e}`, error: true };
  }
};

// Module-global chains so cross-batch same-target calls stay ordered
const globalChains = new Map<string, Promise<void>>();

// Executes a batch of tool calls. Independent calls run concurrently;
// browser/desktop calls are serialized per-target (CDP) or per-class (webview).
// Uses lockKeyFor when available to allow parallel CDP Targets.
export const executeToolCalls = async (rawCalls: string[], ctx: ToolContext): Promise<NamedToolResult[]> => {
  const results: NamedToolResult[] = new Array(rawCalls.length);
  const localChains = new Map<string, Promise<void>>();

  await Promise.all(rawCalls.map((raw, idx) => {
    const { name } = parseToolCall(raw);
    const key = (typeof lockKeyFor !== 'undefined' ? lockKeyFor(name, ctx) : lockClassFor(name));
    const job = () => runOne(raw, ctx).then(r => { results[idx] = r; });
    if (!key) return job();
    const prevLocal = localChains.get(key) ?? Promise.resolve();
    const prevGlobal = globalChains.get(key) ?? Promise.resolve();
    const prev = Promise.all([prevLocal, prevGlobal]).then(()=>{});
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
