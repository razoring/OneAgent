const CDP_HOST = '127.0.0.1';

// Minimal CDP client over global WebSocket (Node 20+ / Electron).
type WsLike = { send(d:string):void; close():void; onopen:(()=>void)|null; onmessage:((e:{data:string})=>void)|null; onerror:((e:any)=>void)|null; onclose:((e:any)=>void)|null; };

const createWs = async (url: string): Promise<WsLike> => {
  const G: any = globalThis as any;
  if (typeof G.WebSocket === 'undefined') throw new Error('CDP requires Node 20+ global WebSocket');
  const ws: any = new G.WebSocket(url);
  return new Promise((res, rej) => {
    const timeout = setTimeout(()=>rej(new Error('CDP ws timeout')), 4000);
    ws.onopen = () => { clearTimeout(timeout); res(ws); };
    ws.onerror = (e:any) => { clearTimeout(timeout); rej(new Error('CDP ws error '+ String(e?.message||e))); };
  });
};

interface CdpSession {
  ws: WsLike;
  id: string;
  nextId: number;
  pending: Map<number, {res:(v:any)=>void, rej:(e:any)=>void}>;
}

const sessions = new Map<string, CdpSession>(); // targetId -> session
const wsByUrl = new Map<string, CdpSession>();

const ensureSession = async (wsUrl: string, targetId: string): Promise<CdpSession> => {
  const existing = sessions.get(targetId);
  if (existing) return existing;
  const ws = await createWs(wsUrl);
  const sess: CdpSession = { ws, id: targetId, nextId: 1, pending: new Map() };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.id != null && sess.pending.has(msg.id)) {
        const p = sess.pending.get(msg.id)!;
        sess.pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.res(msg.result);
      }
    } catch {}
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    sessions.delete(targetId);
    for (const [wsU,s] of wsByUrl.entries()) if (s===sess) wsByUrl.delete(wsU);
    for (const [,p] of sess.pending) p.rej(new Error('CDP session closed'));
    sess.pending.clear();
  };
  sessions.set(targetId, sess);
  wsByUrl.set(wsUrl, sess);
  return sess;
};

const cdpSend = async (wsUrl: string, targetId: string, method: string, params: any = {}): Promise<any> => {
  const sess = await ensureSession(wsUrl, targetId);
  const id = sess.nextId++;
  const payload = JSON.stringify({ id, method, params });
  return new Promise((res, rej) => {
    const timer = setTimeout(()=> { sess.pending.delete(id); rej(new Error(`CDP ${method} timeout`)); }, 15000);
    sess.pending.set(id, { res: (v)=>{clearTimeout(timer); res(v);}, rej: (e)=>{clearTimeout(timer); rej(e);} });
    try { sess.ws.send(payload); } catch (e) { clearTimeout(timer); sess.pending.delete(id); rej(e); }
  });
};

const fetchJson = async (url: string): Promise<any> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDP http ${res.status} ${url}`);
  return res.json();
};

export const cdpVersion = async (port=9222): Promise<any> => fetchJson(`http://${CDP_HOST}:${port}/json/version`);
export const cdpList = async (port=9222): Promise<any[]> => fetchJson(`http://${CDP_HOST}:${port}/json/list`);
export const cdpNewTarget = async (port:number, url='about:blank'): Promise<any> => {
  const res = await fetch(`http://${CDP_HOST}:${port}/json/new?${new URLSearchParams({url})}` , { method:'PUT' } as any);
  // Chrome PUT /json/new?url=...
  if (!res.ok) {
    // Fallback GET
    const r2 = await fetch(`http://${CDP_HOST}:${port}/json/new?url=${encodeURIComponent(url)}`);
    if (!r2.ok) throw new Error(`CDP new target failed ${r2.status}`);
    return r2.json();
  }
  return res.json();
};
export const cdpCloseTarget = async (port:number, id:string): Promise<void> => {
  await fetch(`http://${CDP_HOST}:${port}/json/close/${id}`).catch(()=>{});
  sessions.delete(id);
};

export const cdpActivateTarget = async (port:number, id:string): Promise<void> => {
  await fetch(`http://${CDP_HOST}:${port}/json/activate/${id}`).catch(()=>{});
};

// High-level helpers used by tool layer
export const cdpNavigate = async (port:number, targetId:string, wsUrl:string, url:string): Promise<void> => {
  await cdpSend(wsUrl, targetId, 'Page.enable', {});
  await cdpSend(wsUrl, targetId, 'Page.navigate', { url });
};

export const cdpCaptureScreenshot = async (port:number, targetId:string, wsUrl:string): Promise<string> => {
  // Ensure Page domain enabled
  await cdpSend(wsUrl, targetId, 'Page.enable', {}).catch(()=>{});
  const res: any = await cdpSend(wsUrl, targetId, 'Page.captureScreenshot', { format:'png', captureBeyondViewport:true });
  const data = res?.data;
  if (!data) throw new Error('Blank capture — CDP returned no data');
  return `data:image/png;base64,${data}`;
};

export const cdpEvaluate = async (port:number, targetId:string, wsUrl:string, expression:string, awaitPromise=true): Promise<any> => {
  await cdpSend(wsUrl, targetId, 'Runtime.enable', {}).catch(()=>{});
  const res: any = await cdpSend(wsUrl, targetId, 'Runtime.evaluate', { expression, awaitPromise, returnByValue:true });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails?.text || JSON.stringify(res.exceptionDetails));
  return res?.result?.value;
};

export const cdpDispatchMouse = async (port:number, targetId:string, wsUrl:string, type:'mousePressed'|'mouseReleased'|'mouseMoved'|'mouseWheel', x:number,y:number, opts:any={}): Promise<void> => {
  await cdpSend(wsUrl, targetId, 'Input.dispatchMouseEvent', { type, x, y, button: opts.button||'left', clickCount: opts.clickCount||1, modifiers: opts.modifiers||0, deltaX: opts.deltaX||0, deltaY: opts.deltaY||0, ...opts });
};

export const cdpDispatchKey = async (port:number, targetId:string, wsUrl:string, type:'keyDown'|'keyUp'|'char', key:string, opts:any={}): Promise<void> => {
  // key: use text for char, key for keyDown
  const params: any = { type, text: opts.text, key, ...opts };
  await cdpSend(wsUrl, targetId, 'Input.dispatchKeyEvent', params);
};

export const cdpInsertText = async (port:number, targetId:string, wsUrl:string, text:string): Promise<void> => {
  await cdpSend(wsUrl, targetId, 'Input.insertText', { text });
};

export const cdpGetCookies = async (port:number, targetId:string, wsUrl:string): Promise<any[]> => {
  const res: any = await cdpSend(wsUrl, targetId, 'Storage.getCookies', {});
  return res?.cookies || [];
};

// Utility to find wsUrl for a targetId via /json/list
export const resolveWsUrl = async (port:number, targetId:string): Promise<string> => {
  const list: any[] = await cdpList(port);
  const t = list.find(x=> x.id===targetId);
  if (!t?.webSocketDebuggerUrl) throw new Error(`CDP target ${targetId} not found`);
  return t.webSocketDebuggerUrl;
};

export const closeSession = (targetId:string) => {
  const s = sessions.get(targetId);
  if (s) { try { s.ws.close(); } catch {}; sessions.delete(targetId); }
};

export const genericCdpSend = cdpSend;
export { cdpSend };
