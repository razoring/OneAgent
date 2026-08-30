import { cdpBrowserStore } from './cdpBrowserStore';

const api = (): any => (window as any).electronAPI;

const getTarget = async (agentId: string | null | undefined): Promise<{ target: any, port: number }> => {
  const act = agentId !== undefined ? agentId : null;
  const t = await cdpBrowserStore.ensureTarget(act);
  return { target: t, port: t.port };
};

const cdpCmd = async (targetId: string, port: number, method: string, params: any = {}): Promise<any> => {
  const res = await api().cdpCommand({ port, targetId, method, params });
  if (!res?.success) throw new Error(res?.error || `CDP ${method} failed`);
  return res.result;
};

// Reuse the same SoM JS from browserTools (copy the injection string)
const SOM_JS = `
(function() {
  document.querySelectorAll('.oneagent-som-marker').forEach(e => e.remove());
  const interactiveSelectors = [
    'a', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="menuitem"]',
    '[tabindex]:not([tabindex="-1"])',
    'summary', 'video', 'audio'
  ].join(', ');
  const elements = Array.from(document.querySelectorAll(interactiveSelectors));
  const markers = [];
  window.__oneagentSom = window.__oneagentSom || { nextId: 1, byFingerprint: {} };
  const somState = window.__oneagentSom;
  function somBaseFingerprint(el) {
    const tag = el.tagName.toLowerCase();
    const text = ((el.textContent || el.value || el.alt || el.getAttribute('aria-label') || '') + '').trim().replace(/\\s+/g, ' ').substring(0, 80);
    const href = (tag === 'a' && el.getAttribute('href')) ? el.getAttribute('href').substring(0, 120) : '';
    const extra = (el.getAttribute('type') || '') + '|' + (el.getAttribute('name') || '');
    return tag + '|' + text + '|' + href + '|' + extra;
  }
  const seenCounts = {};
  const fullFingerprints = elements.map(el => {
    const base = somBaseFingerprint(el);
    seenCounts[base] = (seenCounts[base] || 0);
    return base + '#' + (seenCounts[base]++);
  });
  elements.forEach((el, idx) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) return;
    const fullFp = fullFingerprints[idx];
    let id = somState.byFingerprint[fullFp];
    if (!id) { id = somState.nextId++; somState.byFingerprint[fullFp] = id; }
    let container = document.getElementById('oneagent-som-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'oneagent-som-container';
      Object.assign(container.style, { position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2147483647', margin: '0', padding: '0', border: 'none' });
      document.documentElement.appendChild(container);
    }
    const marker = document.createElement('div');
    marker.className = 'oneagent-som-marker';
    marker.textContent = id;
    const somColors = ['#ff3b30', '#007aff', '#34c759', '#ff9500', '#af52de', '#00c7be', '#ff2d55', '#5856d6', '#84fc1b', '#ffcc00'];
    const somColor = somColors[id % somColors.length];
    Object.assign(marker.style, { position: 'absolute', top: (window.scrollY + rect.top) + 'px', left: (window.scrollX + rect.left) + 'px', background: somColor, color: (somColor === '#ffcc00' || somColor === '#84fc1b') ? 'black' : 'white', fontSize: '26px', fontWeight: '900', padding: '4px 8px', borderRadius: '8px', pointerEvents: 'none', boxShadow: '0 0 2px rgba(0,0,0,0.5)', lineHeight: '1' });
    const border = document.createElement('div');
    border.className = 'oneagent-som-marker';
    Object.assign(border.style, { position: 'absolute', top: (window.scrollY + rect.top) + 'px', left: (window.scrollX + rect.left) + 'px', width: rect.width + 'px', height: rect.height + 'px', border: '3px solid ' + somColor, pointerEvents: 'none' });
    container.appendChild(border);
    container.appendChild(marker);
    window.__oneagentElements = window.__oneagentElements || {};
    window.__oneagentElements[id] = el;
    el.setAttribute('som-id', id.toString());
    markers.push({ id, tag: el.tagName.toLowerCase(), text: ((el.innerText !== undefined ? el.innerText : '') || el.value || el.alt || '').replace(/\\s+/g, ' ').trim().substring(0, 80), rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } });
  });
  return markers;
})();
`;

export const cdpInjectSoM = async (agentId?: string | null): Promise<any[]> => {
  const { target, port } = await getTarget(agentId ?? null as any);
  const res = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: SOM_JS, awaitPromise: true, returnByValue: true });
  // Runtime.evaluate returns {result: {value: markers}} when returnByValue true
  const val = (res as any)?.result?.value ?? res?.value ?? res;
  return Array.isArray(val) ? val : [];
};

export const cdpClearSoM = async (agentId?: string | null): Promise<void> => {
  const { target, port } = await getTarget(agentId ?? null as any);
  await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: `document.querySelectorAll('.oneagent-som-marker').forEach(e=>e.remove());`, returnByValue: true }).catch(()=>{});
};

export const cdpCapture = async (agentId?: string | null): Promise<string> => {
  const { target, port } = await getTarget(agentId ?? null as any);
  // Ensure Page enabled
  await cdpCmd(target.id, port, 'Page.enable', {}).catch(()=>{});
  const res: any = await cdpCmd(target.id, port, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const data = res?.data;
  if (!data) throw new Error('Blank capture — CDP returned no data');
  return `data:image/png;base64,${data}`;
};

export const cdpCaptureWithSoM = async (agentId?: string | null): Promise<{ image: string, markers: any[] }> => {
  let markers: any[] = [];
  try { markers = await cdpInjectSoM(agentId); } catch {}
  await new Promise(r => setTimeout(r, 140));
  const image = await cdpCapture(agentId);
  try { await cdpClearSoM(agentId); } catch {}
  return { image, markers };
};

export const cdpGetDom = async (agentId?: string | null): Promise<string> => {
  const { target, port } = await getTarget(agentId ?? null as any);
  const js = `
    (function() {
      try {
        function buildNodeString(node, indent) {
          indent = indent || '';
          if (node.nodeType === Node.TEXT_NODE) { const text = node.textContent.trim().replace(/\\s+/g, ' '); return text ? indent + text + '\\n' : ''; }
          if (node.nodeType !== Node.ELEMENT_NODE) return '';
          const tag = node.tagName.toLowerCase();
          if (['script','style','noscript','svg','path','meta','link'].includes(tag)) return '';
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return '';
          let str = indent + '<' + tag;
          const allowedAttrs = ['id','class','role','aria-label','placeholder','type','value','href','som-id'];
          for (let i=0;i<allowedAttrs.length;i++) { const attr=allowedAttrs[i]; const val=node.getAttribute(attr); if(val){ str+=' '+attr+'="'+val.replace(/"/g,'&quot;')+'"'; } }
          str+='>\\n';
          let childOutput=''; for(let i=0;i<node.childNodes.length;i++) childOutput+=buildNodeString(node.childNodes[i], indent+'  ');
          if (childOutput || ['input','img','textarea','button','a','select'].includes(tag) || node.hasAttribute('som-id')) { str+=childOutput; if(!['input','img','meta','link','hr','br'].includes(tag)) str+=indent+'</'+tag+'>\\n'; return str; }
          return '';
        }
        return buildNodeString(document.body, '').substring(0, 40000);
      } catch (err) { return '[browser_get_dom error] ' + (err && err.message ? err.message : String(err)); }
    })();
  `;
  const res = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
  const v = (res as any)?.result?.value ?? res?.value ?? res;
  return typeof v === 'string' ? v : String(v ?? '');
};

export const cdpNavigate = async (agentId: string | null | undefined, url: string): Promise<string> => {
  const act = agentId !== undefined ? agentId : null;
  const t = await cdpBrowserStore.ensureTarget(act);
  const port = t.port;
  await cdpCmd(t.id, port, 'Page.enable', {}).catch(()=>{});
  await cdpCmd(t.id, port, 'Page.navigate', { url });
  // Wait for load
  const start = Date.now();
  while (Date.now() - start < 15000) {
    await new Promise(r=>setTimeout(r, 200));
    try {
      const ready = await cdpCmd(t.id, port, 'Runtime.evaluate', { expression: `document.readyState`, returnByValue: true });
      const state = (ready as any)?.result?.value ?? ready?.value;
      if (state === 'complete') break;
    } catch {}
  }
  return `Navigation complete: ${url}`;
};

export const cdpClick = async (agentId: string | null | undefined, id?: number, x?: number, y?: number, button: string='left', clickCount=1, modifiers:number=0): Promise<string> => {
  const act = agentId !== undefined ? agentId : null;
  const { target, port } = await getTarget(act);
  let px = x, py = y;
  if (id != null) {
    const js = `(function(){ const el=window.__oneagentElements && window.__oneagentElements[${Number(id)}]; if(!el||!el.isConnected) return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`;
    const res = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
    const v: any = (res as any)?.result?.value ?? res?.value ?? res;
    if (!v || typeof v.x !== 'number') return `Element ${id} not found — take a browser_observe to re-label the page and retry`;
    px = v.x; py = v.y;
  }
  if (px == null || py == null) return 'Target not found — provide id or x/y';
  const btn = button as any;
  await cdpCmd(target.id, port, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: btn, clickCount, modifiers });
  await new Promise(r=>setTimeout(r, 50));
  await cdpCmd(target.id, port, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: btn, clickCount, modifiers });
  return `Clicked ${id != null ? `element ${id}` : `(${px},${py})`}`;
};

export const cdpType = async (agentId: string | null | undefined, text: string, id?: number, submit=false): Promise<string> => {
  const act = agentId !== undefined ? agentId : null;
  const { target, port } = await getTarget(act);
  if (id != null) {
    const js = `(function(){ const el=window.__oneagentElements && window.__oneagentElements[${Number(id)}]; if(!el) return false; el.scrollIntoView({block:'center',inline:'center'}); el.focus(); return true; })()`;
    const focused = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: js, returnByValue: true });
    const v: any = (focused as any)?.result?.value ?? focused?.value;
    if (!v) return `Element ${id} not found — take a browser_observe to re-label the page and retry`;
    await new Promise(r=>setTimeout(r, 80));
  }
  // Select all + delete
  await cdpCmd(target.id, port, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 }).catch(()=>{});
  await cdpCmd(target.id, port, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 40));
  await cdpCmd(target.id, port, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace' }).catch(()=>{});
  await cdpCmd(target.id, port, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace' }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 40));
  await cdpCmd(target.id, port, 'Input.insertText', { text }).catch(async ()=> {
    // Fallback per-char
    for (const ch of text) {
      await cdpCmd(target.id, port, 'Input.dispatchKeyEvent', { type: 'char', text: ch }).catch(()=>{});
      await new Promise(r=>setTimeout(r, 12));
    }
  });
  await new Promise(r=>setTimeout(r, 180));
  if (submit) {
    await cdpCmd(target.id, port, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' }).catch(()=>{});
    await cdpCmd(target.id, port, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' }).catch(()=>{});
    await new Promise(r=>setTimeout(r, 250));
    return `Typed "${text}" and pressed Enter to submit.`;
  }
  return `Typed "${text}" into the field.`;
};

export const cdpScroll = async (agentId: string | null | undefined, direction='down', amount=600, id?: number): Promise<string> => {
  const act = agentId !== undefined ? agentId : null;
  const { target, port } = await getTarget(act);
  if (direction === 'top' || direction === 'bottom') {
    if (id != null) {
      const ok = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: `(()=>{const el=window.__oneagentElements[${Number(id)}]; if(!el||!el.isConnected) return false; el.scrollIntoView({block:'${direction==='top'?'start':'end'}', behavior:'instant'}); return true;})()`, returnByValue:true });
      const v:any = (ok as any)?.result?.value ?? ok?.value;
      if (!v) return `Element ${id} not found — take a browser_observe to re-label`;
    } else {
      await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: `window.scrollTo({top:${direction==='top'?'0':'document.documentElement.scrollHeight'}, behavior:'instant'}); true`, returnByValue:true });
    }
    await new Promise(r=>setTimeout(r, 250));
    return `Scrolled to ${direction}`;
  }
  let x=640,y=400;
  if (id != null) {
    const js = `(function(){ const el=window.__oneagentElements[${Number(id)}]; if(!el) return null; el.scrollIntoView({block:'center',inline:'center'}); const r=el.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`;
    const res = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: js, returnByValue: true });
    const v:any = (res as any)?.result?.value ?? res?.value;
    if (!v) return `Element ${id} not found — take a browser_observe to re-label`;
    x=v.x; y=v.y;
  } else {
    const vp = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: `({x:Math.round(window.innerWidth/2), y:Math.round(window.innerHeight/2)})`, returnByValue: true });
    const v:any = (vp as any)?.result?.value ?? vp?.value;
    if (v) { x=v.x; y=v.y; }
  }
  const dx = direction==='left'?-amount:direction==='right'?amount:0;
  const dy = direction==='up'?-amount:direction==='down'?amount:0;
  // Try wheel
  await cdpCmd(target.id, port, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 250));
  // Verify movement via JS; fallback to window.scrollBy
  const before: any = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: `(()=>{const d=document.scrollingElement||document.documentElement; return {y:Math.round(d.scrollTop), maxY:Math.round(d.scrollHeight-d.clientHeight)}})()`, returnByValue:true });
  const b = (before as any)?.result?.value ?? before?.value ?? before;
  // Try programmatic scroll
  await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: `window.scrollBy(${dx},${dy}); true`, returnByValue:true }).catch(()=>{});
  await new Promise(r=>setTimeout(r, 200));
  const after: any = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: `(()=>{const d=document.scrollingElement||document.documentElement; return {y:Math.round(d.scrollTop), maxY:Math.round(d.scrollHeight-d.clientHeight)}})()`, returnByValue:true });
  const a = (after as any)?.result?.value ?? after?.value ?? after;
  if (a && b && Math.abs(a.y - b.y) >= 1) return `Scrolled ${direction} ${amount}px — now at y=${a.y}/${a.maxY}`;
  // Already at limit?
  if (a && a.maxY <= 0) return `Could not scroll ${direction}: no movement (fits viewport)`;
  return `Scrolled ${direction} ${amount}px`;
};

export const cdpEvaluate = async (agentId: string | null | undefined, script: string): Promise<any> => {
  const act = agentId !== undefined ? agentId : null;
  const { target, port } = await getTarget(act);
  const expr = script.trim().startsWith('return') ? `(function(){ ${script} })()` : script;
  const res = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const v: any = (res as any)?.result?.value ?? res?.value ?? res;
  return v;
};

export const cdpObserve = async (agentId?: string | null): Promise<{ image: string, markers: any[], dom: string, meta: any }> => {
  const act = agentId !== undefined ? agentId : null;
  const { target, port } = await getTarget(act);
  const { image, markers } = await cdpCaptureWithSoM(act);
  const dom = await cdpGetDom(act);
  // Meta similar to browserTools browserObservePage
  const meta: any = await cdpCmd(target.id, port, 'Runtime.evaluate', { expression: `(()=>{const d=document.scrollingElement||document.documentElement; return {scrollX:Math.round(window.scrollX), scrollY:Math.round(window.scrollY), maxX:Math.round(d.scrollWidth-d.clientWidth), maxY:Math.round(d.scrollHeight-d.clientHeight), viewport:{width:window.innerWidth,height:window.innerHeight}, atTop: window.scrollY<=2, atBottom: (d.scrollTop+d.clientHeight)>=d.scrollHeight-2, url: location.href, title: document.title}})()`, returnByValue:true }).then((r:any)=> r?.result?.value ?? r?.value ?? {}).catch(()=>({}));
  return { image, markers, dom, meta };
};
