import { agentBrowserStore, getCurrentActor } from './agentBrowserStore';

// ─── Tab substrate (main-process WebContentsView) ──────────────────────────
// Tabs live in MAIN as WebContentsViews attached to mainWindow.contentView.
// Renderer talks via IPC; this module provides a webview-shaped proxy so
// existing tools keep their shape. Per-tab state mirrored from main events.

const api = (): any => (window as any).electronAPI;

interface TabRuntime { url: string; title: string; loading: boolean; ready: boolean }
const runtimeById = new Map<string, TabRuntime>();
let eventsInstalled = false;

const ensureTabEvents = () => {
  if (eventsInstalled || !api()?.onTabEvent) return;
  eventsInstalled = true;
  api().onTabEvent((ev: any) => {
    const cur = runtimeById.get(ev.tabId) ?? { url: '', title: '', loading: false, ready: false };
    runtimeById.set(ev.tabId, { ...cur, ...ev });
    agentBrowserStore.patchTab(ev.tabId, {
      ...(ev.url !== undefined ? { url: ev.url } : {}),
      ...(ev.title !== undefined ? { title: ev.title } : {}),
      ...(ev.loading !== undefined ? { loading: ev.loading } : {})
    });
  });
};

const fetchTabState = async (tabId: string): Promise<TabRuntime | null> => {
  try {
    const st = await api().tabState(tabId);
    if (!st) return null;
    const merged: TabRuntime = {
      url: st.url ?? '', title: st.title ?? '',
      loading: !!st.loading, ready: !!st.ready
    };
    runtimeById.set(tabId, merged);
    return merged;
  } catch { return null; }
};

export const getActiveWebview = () => null;

// Actor-aware target resolution: a sub-agent's browser_* calls hit ITS OWN
// tab; the user / orchestrator hit the currently visible one. Returns a tab
// id, or null while a freshly created tab is still initializing. Creating an
// actor's tab goes through the main process (it owns tab ids). Offscreen tabs
// are created immediately with valid bounds so capture works without user paint.
// Accepts explicit actor to avoid global race when two agents run concurrently.
const resolveTargetTabId = async (actorOverride?: string | null): Promise<string | null> => {
  ensureTabEvents();
  const actor = actorOverride !== undefined ? actorOverride : getCurrentActor();
  let tabId: string | null | undefined;
  if (actor) {
    tabId = agentBrowserStore.getTabIdForAgent(actor);
    if (!tabId) {
      // Pass agentId to main so managedTabs can be looked up by agent as well
      const created: string | undefined = await api().tabCreate({ url: agentBrowserStore.HOME_URL, agentId: actor } as any);
      // Fallback to legacy string form if main rejects object form
      let cid = created;
      if (!cid) cid = await api().tabCreate(agentBrowserStore.HOME_URL) as any;
      if (!cid) return null;
      const meta = agentBrowserStore.ensureAgentTab(actor);
      // Main already created with correct id when object form succeeds — rekey only if ids differ
      if (meta.id !== cid) agentBrowserStore.rekeyTab(meta.id, cid);
      runtimeById.set(cid, { url: agentBrowserStore.HOME_URL, title: 'New Tab', loading: false, ready: false });
      tabId = cid;
    }
  } else {
    tabId = agentBrowserStore.getActiveId();
  }
  return tabId ?? null;
};

// Webview-shaped proxy over one main-process view.
const makeProxy = (tabId: string) => {
  const rt = () => runtimeById.get(tabId) ?? { url: '', title: '', loading: false, ready: false };
  return {
    __tabId: tabId,
    getURL: () => rt().url,
    getTitle: () => rt().title,
    isLoading: () => rt().loading,
    getWebContentsId: () => tabId,
    executeJavaScript: (code: string) => api().tabExec(tabId, code),
    loadURL: (url: string) => api().tabCall(tabId, 'loadURL', url),
    goBack: () => api().tabCall(tabId, 'goBack'),
    goForward: () => api().tabCall(tabId, 'goForward'),
    reload: () => api().tabCall(tabId, 'reload'),
    stop: () => api().tabCall(tabId, 'stop')
  };
};

// Polls for the actor's tab to exist and be ready. For background agent tabs
// we wait for dom-ready up to 3.5s; capturePage in main will also wait, but
// returning before ready caused blank captures (Chrome culls not-ready views).
// executeJavaScript no longer gates on ready but capture does.
// Captures the actor at entry to avoid global race when two agents run
// concurrently (per-tab locks allow parallel, but global currentActor would race).
export const waitForActiveWebview = async (timeoutMs = 15000, actorOverride?: string | null): Promise<any> => {
  ensureTabEvents();
  const capturedActor = actorOverride !== undefined ? actorOverride : getCurrentActor();
  const start = Date.now();
  let lastTabId: string | null = null;
  while (Date.now() - start < timeoutMs) {
    const tabId = await resolveTargetTabId(capturedActor);
    if (!tabId) { await new Promise(r => setTimeout(r, 100)); continue; }
    lastTabId = tabId;
    const st = await fetchTabState(tabId);
    if (st) {
      if (st.ready) return makeProxy(tabId);
      // If loading finished but dom-ready hasn't fired yet (e.g. about:blank), return after short grace
      if (!st.loading && Date.now() - start > 900) return makeProxy(tabId);
      // Absolute deadline so simultaneous agent tabs don't deadlock forever
      if (Date.now() - start > 3500) return makeProxy(tabId);
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (lastTabId) return makeProxy(lastTabId);
  throw new Error('No active webview available');
};

// No display scaling — WebContentsView bounds are 1:1 with viewport CSS pixels.
const sendInputEvent = async (opts: any) =>
  (window as any).electronAPI.browserSendInputEvent(opts);

// Injects the Set-of-Mark overlay into the webview and returns the annotated DOM mapping.
export const injectSetOfMark = async (): Promise<any> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const code = `
    (function() {
      // Remove old markers if any
      document.querySelectorAll('.oneagent-som-marker').forEach(e => e.remove());

      const interactiveSelectors = [
        'a', 'button', 'input', 'select', 'textarea', 
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="menuitem"]',
        '[tabindex]:not([tabindex="-1"])',
        'summary', 'video', 'audio'
      ].join(', ');

      const elements = Array.from(document.querySelectorAll(interactiveSelectors));
      const markers = [];

      // Persistent element identity within this page document: an element keeps
      // its som-id across observations (scrolling included), so counts and
      // references stay valid. Navigating creates a fresh JS context here,
      // which resets numbering to 1 for the new page automatically.
      window.__oneagentSom = window.__oneagentSom || { nextId: 1, byFingerprint: {} };
      const somState = window.__oneagentSom;

      function somBaseFingerprint(el) {
        const tag = el.tagName.toLowerCase();
        const text = ((el.textContent || el.value || el.alt || el.getAttribute('aria-label') || '') + '')
          .trim().replace(/\\s+/g, ' ').substring(0, 80);
        const href = (tag === 'a' && el.getAttribute('href')) ? el.getAttribute('href').substring(0, 120) : '';
        const extra = (el.getAttribute('type') || '') + '|' + (el.getAttribute('name') || '');
        return tag + '|' + text + '|' + href + '|' + extra;
      }

      // Fingerprints are computed over ALL matched elements (visible or not),
      // so duplicate texts like "Read more" get stable occurrence indices no
      // matter what the viewport happens to contain this round.
      const seenCounts = {};
      const fullFingerprints = elements.map(el => {
        const base = somBaseFingerprint(el);
        seenCounts[base] = (seenCounts[base] || 0);
        return base + '#' + (seenCounts[base]++);
      });

      elements.forEach((el, idx) => {
        // Skip hidden elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        // Only label elements that intersect with the current viewport
        if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return;

        // Hit-test the center: skip elements that are covered or visually
        // hidden (e.g. offscreen accessibility links Google keeps "visible").
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) return;

        const fullFp = fullFingerprints[idx];
        let id = somState.byFingerprint[fullFp];
        if (!id) {
          id = somState.nextId++;
          somState.byFingerprint[fullFp] = id;
        }
        
        // Create or get container to ensure absolute coordinates match perfectly
        let container = document.getElementById('oneagent-som-container');
        if (!container) {
          container = document.createElement('div');
          container.id = 'oneagent-som-container';
          Object.assign(container.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '2147483647',
            margin: '0',
            padding: '0',
            border: 'none'
          });
          document.documentElement.appendChild(container);
        }

        const marker = document.createElement('div');
        marker.className = 'oneagent-som-marker';
        marker.textContent = id;
        // Distinct high-contrast color per id so the model can pair each
        // numbered badge with its outlined element even in small screenshots.
        const somColors = ['#ff3b30', '#007aff', '#34c759', '#ff9500', '#af52de', '#00c7be', '#ff2d55', '#5856d6', '#84fc1b', '#ffcc00'];
        const somColor = somColors[id % somColors.length];
        Object.assign(marker.style, {
          position: 'absolute',
          top: (window.scrollY + rect.top) + 'px',
          left: (window.scrollX + rect.left) + 'px',
          background: somColor,
          color: (somColor === '#ffcc00' || somColor === '#84fc1b') ? 'black' : 'white',
          fontSize: '26px',
          fontWeight: '900',
          padding: '4px 8px',
          borderRadius: '8px',
          pointerEvents: 'none',
          boxShadow: '0 0 2px rgba(0,0,0,0.5)',
          lineHeight: '1'
        });

        const border = document.createElement('div');
        border.className = 'oneagent-som-marker';
        Object.assign(border.style, {
          position: 'absolute',
          top: (window.scrollY + rect.top) + 'px',
          left: (window.scrollX + rect.left) + 'px',
          width: rect.width + 'px',
          height: rect.height + 'px',
          border: '3px solid ' + somColor,
          pointerEvents: 'none'
        });

        container.appendChild(border);
        container.appendChild(marker);

        // Save element reference to window for later interaction
        window.__oneagentElements = window.__oneagentElements || {};
        window.__oneagentElements[id] = el;
        el.setAttribute('som-id', id.toString());

        markers.push({
          id,
          tag: el.tagName.toLowerCase(),
          // innerText respects visibility and inserts line breaks between
          // block children — textContent would fuse adjacent nodes into one
          // garbled token (e.g. "...City of Toronto" + "Kijiji" → "TorontoKij").
          text: ((el.innerText !== undefined ? el.innerText : '') || el.value || el.alt || '')
            .replace(/\s+/g, ' ').trim().substring(0, 80),
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        });
      });
      return markers;
    })();
  `;

  return await wv.executeJavaScript(code);
};

export const getSemanticDOM = async (): Promise<string> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  // If a navigation is in flight (e.g. after browser_keystrokes click), let it
  // finish so we read the settled page instead of a torn-down document.
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      if (!wv.isLoading()) break;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }

  const code = `
    (function() {
      try {
        function buildNodeString(node, indent) {
          indent = indent || '';
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim().replace(/\\s+/g, ' ');
            return text ? indent + text + '\\n' : '';
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return '';
          
          const tag = node.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg', 'path', 'meta', 'link'].includes(tag)) return '';
          
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return '';

          let str = indent + '<' + tag;
          
          const allowedAttrs = ['id', 'class', 'role', 'aria-label', 'placeholder', 'type', 'value', 'href', 'som-id'];
          for (let i = 0; i < allowedAttrs.length; i++) {
             const attr = allowedAttrs[i];
             const val = node.getAttribute(attr);
             if (val) {
               // Escape quotes for clean output
               const safeVal = val.replace(/"/g, '&quot;');
               str += ' ' + attr + '="' + safeVal + '"';
             }
          }
          str += '>\\n';
          
          let childOutput = '';
          for (let i = 0; i < node.childNodes.length; i++) {
             childOutput += buildNodeString(node.childNodes[i], indent + '  ');
          }
          
          // Always output structural interactive elements even if empty, but skip empty wrapper divs
          if (childOutput || ['input', 'img', 'textarea', 'button', 'a', 'select'].includes(tag) || node.hasAttribute('som-id')) {
             str += childOutput;
             // Only close tags that usually have closing tags and are not empty without reason
             if (!['input', 'img', 'meta', 'link', 'hr', 'br'].includes(tag)) {
               str += indent + '</' + tag + '>\\n';
             }
             return str;
          }
          return ''; // skip empty wrapper elements
        }
        
        return buildNodeString(document.body, '').substring(0, 40000);
      } catch (err) {
        return '[browser_get_dom error] ' + (err && err.message ? err.message : String(err));
      }
    })();
  `;
  return await wv.executeJavaScript(code);
};

export const clearSetOfMark = async (): Promise<void> => {
  const wv = await waitForActiveWebview();
  if (!wv) return;
  await wv.executeJavaScript(`document.querySelectorAll('.oneagent-som-marker').forEach(e => e.remove());`);
};

// Captures only the embedded agent browser viewport (not the whole monitor).
// Injects Set-of-Mark labels first so the screenshot shows numbered element
// badges, then hides the overlay. The id→element map stays alive in the page
// so the returned IDs remain usable with browser_type / browser_keystrokes.
export const captureBrowserScreenshot = async (): Promise<{ image: string, markers: any[] }> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");
  const electronAPI = (window as any).electronAPI;
  if (!electronAPI?.browserCapture) throw new Error("Browser capture is not available");

  let markers: any[] = [];
  try {
    markers = (await injectSetOfMark()) || [];
  } catch {}
  // Give the overlay a frame to paint before capturing
  await new Promise(r => setTimeout(r, 150));

  try {
    const res = await electronAPI.browserCapture(wv.getWebContentsId());
    if (!res?.success || !res.image) throw new Error(res?.error || "Failed to capture browser screenshot");
    return { image: res.image, markers };
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes('UnknownVizError') || msg.includes('not found') || msg.includes('not available')) {
      throw new Error("Browser page is not ready (blank or still loading). Navigate to a URL first with browser_navigate, or wait a moment and retry browser_observe.");
    }
    throw err;
  } finally {
    try { await clearSetOfMark(); } catch {}
  }
};

// Normalizes common key names to Electron's expected casing ('enter' -> 'Enter').
const normalizeKeyCode = (key: string): string => {
  if (!key || key.length === 1) return key || '';
  const named: Record<string, string> = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape',
    backspace: 'Backspace', delete: 'Delete', del: 'Delete', space: ' ', spacebar: ' ',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown'
  };
  const k = key.toLowerCase();
  return named[k] || key.charAt(0).toUpperCase() + key.slice(1);
};

const sendKey = async (webContentsId: number, keyCode: string, modifiers: string[] = [], state: 'press' | 'down' | 'up' = 'press') => {
  if (state === 'down' || state === 'press') {
    const r = await sendInputEvent({ webContentsId, type: 'keyDown', keyCode, modifiers });
    if (r && r.success === false) return r;
  }
  if (state === 'up' || state === 'press') {
    await new Promise(r => setTimeout(r, 40));
    const r = await sendInputEvent({ webContentsId, type: 'keyUp', keyCode, modifiers });
    if (r && r.success === false) return r;
  }
  return { success: true };
};

// Reads the value/text of the currently focused editable element (null if none).
const readFocusedEditableText = (wv: any) =>
  wv.executeJavaScript(`(function(){
    var el = document.activeElement;
    if (!el) return null;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return el.value || '';
    if (el.isContentEditable) return el.innerText || '';
    return null;
  })()`);

// Types text into the focused element and VERIFIES it landed. Tries insertText
// first, then falls back to per-character hardware events (React-controlled
// inputs often ignore insertText). Returns an honest ok/detail result.
const typeTextIntoFocus = async (wv: any, webContentsId: number, text: string): Promise<{ ok: boolean, detail: string }> => {
  const electronAPI = (window as any).electronAPI;

  await electronAPI.browserInsertText({ webContentsId, text });
  await new Promise(r => setTimeout(r, 150));
  let cur = await readFocusedEditableText(wv);
  if (typeof cur === 'string' && cur.includes(text)) return { ok: true, detail: 'insertText' };

  for (const ch of text) {
    if (ch === '\n') {
      await sendKey(webContentsId, 'Enter');
    } else {
      const r = await sendInputEvent({ webContentsId, type: 'char', keyCode: ch });
      if (r && r.success === false) return { ok: false, detail: r.error || 'keyboard event was rejected' };
    }
    await new Promise(r => setTimeout(r, 12));
  }
  await new Promise(r => setTimeout(r, 200));
  cur = await readFocusedEditableText(wv);
  if (typeof cur === 'string' && cur.includes(text)) return { ok: true, detail: 'per-character key events' };
  if (cur === null) return { ok: false, detail: 'no focused editable element received the text' };
  return { ok: false, detail: `the field contains "${String(cur).substring(0, 80)}" instead of "${text}"` };
};

// Animates the cursor to a Set-of-Mark element and resolves its viewport center.
const clickElementCenter = async (wv: any, id: number, highlight: boolean): Promise<{ x: number, y: number } | null> => {
  const code = `
    (function() {
      return new Promise((resolve) => {
        const el = window.__oneagentElements && window.__oneagentElements[${id}];
        if (!el || !el.isConnected) {
          // Detached by a page update — prune so the next observe re-labels
          // the replacement and reports a fresh, valid id.
          if (el) delete window.__oneagentElements[${id}];
          resolve(null);
          return;
        }

        try {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          function hits(x, y) {
            const t = document.elementFromPoint(x, y);
            return !!t && (t === el || el.contains(t));
          }
          // Geometric center can miss (inserted badges/padding split links) —
          // fall back to the largest hittable text-bearing descendant, then a
          // grid scan of the rect.
          let targetX = Math.round(rect.left + rect.width / 2);
          let targetY = Math.round(rect.top + rect.height / 2);
          if (!hits(targetX, targetY)) {
            let best = null, bestScore = 0;
            el.querySelectorAll('*').forEach(d => {
              const dr = d.getBoundingClientRect();
              if (dr.width < 4 || dr.height < 4) return;
              const dx = Math.round(dr.left + dr.width / 2);
              const dy = Math.round(dr.top + dr.height / 2);
              if (!hits(dx, dy)) return;
              const score = dr.width * dr.height * (((d.textContent || '').trim().length > 0) ? 2 : 1);
              if (score > bestScore) { bestScore = score; best = { x: dx, y: dy }; }
            });
            if (best) { targetX = best.x; targetY = best.y; }
            else {
              scan: for (let gy = 0.2; gy <= 0.8; gy += 0.2) {
                for (let gx = 0.2; gx <= 0.8; gx += 0.2) {
                  const tx = Math.round(rect.left + rect.width * gx), ty = Math.round(rect.top + rect.height * gy);
                  if (hits(tx, ty)) { targetX = tx; targetY = ty; break scan; }
                }
              }
            }
          }

          const computedCursor = window.getComputedStyle(el).cursor;
          // Editable targets always get the I-beam — pages often restyle
          // inputs with custom cursors that would hide it.
          const isEditable = el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName);
          let svgContent = '';
          if (isEditable) {
            svgContent = '<svg width="24" height="40" viewBox="0 0 16 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3H13M8 3V29M3 29H13" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4H12M8 4V28M4 28H12" stroke="black" stroke-width="1" stroke-linejoin="round"/></svg>';
          } else if (computedCursor === 'pointer') {
            svgContent = '<svg width="32" height="40" viewBox="0 0 24 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 1L12 15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 5V15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 8V15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 7V17" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 17L5.5 15.5C4 14.5 2 15.5 2.5 17L5 22C6 24 8 26 10 27C12 28 16 28 18 26C20 24 21 21 21 18V13.5C21 11.5 19 11.5 19 13.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 17L5.5 15.5C4 14.5 2 15.5 2.5 17L5 22C6 24 8 26 10 27C12 28 16 28 18 26C20 24 21 21 21 18V13.5C21 11.5 19 11.5 19 13.5" fill="black"/></svg>';
          } else if (computedCursor === 'text') {
            svgContent = '<svg width="24" height="40" viewBox="0 0 16 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3H13M8 3V29M3 29H13" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4H12M8 4V28M4 28H12" stroke="black" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          } else {
            svgContent = '<svg width="32" height="48" viewBox="0 0 24 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.65376 2.15376C5.42103 1.92103 5.06847 1.8385 4.75338 1.94314C4.4383 2.04778 4.22019 2.31885 4.19702 2.65171L2.03035 33.8517C2.00844 34.1673 2.1969 34.4636 2.49603 34.5843C2.79517 34.7049 3.13653 34.6231 3.34032 34.3813L10.3704 26.0355L16.2731 34.8021C16.4805 35.1097 16.8906 35.1884 17.1889 34.978L22.4206 31.2872C22.7188 31.0768 22.7845 30.666 22.5663 30.3621L16.2238 21.5303H24.3333C24.6468 21.5303 24.9312 21.3414 25.0482 21.0558C25.1652 20.7702 25.0906 20.4431 24.8604 20.2319L5.65376 2.15376Z" fill="black" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';
          }

          const cursor = document.createElement('img');
        cursor.src = 'data:image/svg+xml;base64,' + btoa(svgContent);
          Object.assign(cursor.style, {
            position: 'fixed',
            zIndex: '2147483647',
            pointerEvents: 'none',
            transition: 'all 0.6s cubic-bezier(0.25, 1, 0.5, 1)',
            left: window.innerWidth + 'px',
            top: window.innerHeight + 'px',
            transform: 'translate(-4px, -4px)',
            filter: 'drop-shadow(1px 2px 3px rgba(0,0,0,0.4))'
          });
          document.documentElement.appendChild(cursor);

          setTimeout(() => {
            cursor.style.left = targetX + 'px';
            cursor.style.top = targetY + 'px';
          }, 50);

          setTimeout(() => {
            cursor.style.transform = 'translate(-4px, -4px) scale(0.8)';
            setTimeout(() => cursor.style.transform = 'translate(-4px, -4px) scale(1)', 150);

            if (${highlight ? 'true' : 'false'}) {
              const overlay = document.createElement('div');
              Object.assign(overlay.style, {
                position: 'absolute',
                top: (window.scrollY + rect.top) + 'px',
                left: (window.scrollX + rect.left) + 'px',
                width: rect.width + 'px',
                height: rect.height + 'px',
                background: 'rgba(0, 120, 255, 0.2)',
                pointerEvents: 'none',
                zIndex: '2147483646',
                transition: 'opacity 0.3s'
              });
              document.documentElement.appendChild(overlay);
              setTimeout(() => {
                overlay.style.opacity = '0';
                setTimeout(() => overlay.remove(), 300);
              }, 300);
            }

            setTimeout(() => {
              cursor.style.opacity = '0';
              setTimeout(() => {
                cursor.remove();
                resolve({ x: targetX, y: targetY });
              }, 300);
            }, 300);
          }, 650);

        } catch(e) {
          console.error(e);
          resolve(null);
        }
      });
    })();
  `;
  return await wv.executeJavaScript(code);
};

// Shared hit-test-aware center lookup. Single source for viewport coords — used by
// click animation, scroll targeting and generic point resolution.
const centerJs = (id: number) => `(function(){
    var el = window.__oneagentElements && window.__oneagentElements[${id}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var r = el.getBoundingClientRect();
    function hits(x, y){ var t=document.elementFromPoint(x,y); return !!t && (t===el || el.contains(t)); }
    var cx=Math.round(r.left+r.width/2), cy=Math.round(r.top+r.height/2);
    if(!hits(cx,cy)){
      var best=null, bestScore=0;
      el.querySelectorAll('*').forEach(function(d){
        var dr=d.getBoundingClientRect(); if(dr.width<4||dr.height<4) return;
        var dx=Math.round(dr.left+dr.width/2), dy=Math.round(dr.top+dr.height/2);
        if(!hits(dx,dy)) return;
        var score=dr.width*dr.height*(((d.textContent||'').trim().length>0)?2:1);
        if(score>bestScore){ bestScore=score; best={x:dx,y:dy}; }
      });
      if(best){ cx=best.x; cy=best.y; }
      else { scan: for(var gy=0.2; gy<=0.8; gy+=0.2){ for(var gx=0.2; gx<=0.8; gx+=0.2){ var tx=Math.round(r.left+r.width*gx), ty=Math.round(r.top+r.height*gy); if(hits(tx,ty)){ cx=tx; cy=ty; break scan; }}}}
    }
    return { x: cx, y: cy, rect:{ left:r.left, top:r.top, width:r.width, height:r.height } };
  })()`;

export const getElementCenter = async (wv: any, id: number): Promise<{ x: number, y: number } | null> => {
  const r: any = await wv.executeJavaScript(centerJs(id));
  return r ? { x: r.x, y: r.y } : null;
};

export const browserKeystrokes = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const id = Number(args.id ?? args.Id ?? 0) || 0;
  const action = args.action || args.Action || 'click';
  const state = args.state || args.State || 'click';
  const button = args.button || args.Button || 'left';
  const key = normalizeKeyCode(args.key || args.Key || args.keyCode || '');
  const modifiers = args.modifiers || args.Modifiers || [];
  const value = args.value || args.Value || args.text || args.Text || args.string || '';

  if ((action === 'type') && !value) {
    throw new Error("browser_keystrokes type action requires the text to type in the 'value' parameter");
  }

  const webContentsId = wv.getWebContentsId();

  // Real wheel-event scrolling (the old path sent a bogus mouseDown instead).
  if (action === 'scroll') {
    const dir = String(args.direction || args.Direction || 'down').toLowerCase();
    const amount = Number(args.amount ?? args.Amount ?? 600) || 600;
    const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
    const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
    let x: number, y: number;
    if (id) {
      const c = await getElementCenter(wv, id);
      if (!c) return `Element ${id} not found — take a browser_screenshot to re-label the page and retry`;
      ({ x, y } = c);
    } else {
      ({ x, y } = await wv.executeJavaScript(`({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })`));
    }
    const r = await sendInputEvent({ webContentsId, type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
    if (r && r.success === false) return `Scroll failed: ${r.error}`;
    await new Promise(res => setTimeout(res, 300));
    return `Scrolled ${dir} ${amount}px${id ? ` at element ${id}` : ''}`;
  }

  // Drag: press at source element, interpolate moves, release at destination.
  if (action === 'drag') {
    const coords = await clickElementCenter(wv, id, true);
    if (!coords) return `Element ${id} not found or out of view — take a browser_screenshot to re-label the page and retry`;

    let tx: number | undefined;
    let ty: number | undefined;
    const targetId = args.targetId ?? args.TargetId ?? args.toId ?? args.ToId;
    if (targetId !== undefined && targetId !== null && targetId !== '') {
      const tc = await getElementCenter(wv, Number(targetId));
      if (!tc) return `Target element ${targetId} not found — take a browser_screenshot to re-label the page and retry`;
      ({ x: tx, y: ty } = tc);
    } else if (args.x !== undefined || args.X !== undefined || args.y !== undefined || args.Y !== undefined) {
      tx = Number(args.x ?? args.X ?? 0);
      ty = Number(args.y ?? args.Y ?? 0);
    } else {
      return 'Drag requires a destination: set targetId (Set-of-Mark element) or x/y coordinates';
    }

    await sendInputEvent({ webContentsId, type: 'mouseMove', x: coords.x, y: coords.y });
    await new Promise(r => setTimeout(r, 80));
    await sendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button, clickCount: 1 });
    await new Promise(r => setTimeout(r, 150));

    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const ix = Math.round(coords.x + ((tx as number) - coords.x) * i / steps);
      const iy = Math.round(coords.y + ((ty as number) - coords.y) * i / steps);
      await sendInputEvent({ webContentsId, type: 'mouseMove', x: ix, y: iy });
      await new Promise(r => setTimeout(r, 30));
    }
    await new Promise(r => setTimeout(r, 100));
    await sendInputEvent({ webContentsId, type: 'mouseUp', x: tx as number, y: ty as number, button, clickCount: 1 });
    return `Dragged element ${id} to (${tx}, ${ty})`;
  }

  const coords = await clickElementCenter(wv, id, action === 'type' || action === 'keyboard');
  if (!coords) {
    return `Element ${id} not found or out of view — take a browser_screenshot to re-label the page and retry`;
  }

  if (action === 'mouse' || action === 'click') {
    let type = 'mouseDown';
    if (state === 'up') type = 'mouseUp';
    if (state === 'move' || state === 'hover') type = 'mouseMove';

    if (state === 'click') {
      await sendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button, clickCount: 1, modifiers });
      await new Promise(r => setTimeout(r, 50));
      await sendInputEvent({ webContentsId, type: 'mouseUp', x: coords.x, y: coords.y, button, clickCount: 1, modifiers });
    } else {
      await sendInputEvent({ webContentsId, type, x: coords.x, y: coords.y, button, clickCount: 1, modifiers });
    }
    return `${state === 'click' ? 'Clicked' : state} element ${id} at (${coords.x}, ${coords.y})`;
  }

  if (action === 'keyboard' || action === 'type') {
    // Focus first
    await sendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await sendInputEvent({ webContentsId, type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 120));

    if (action === 'type') {
      const res = await typeTextIntoFocus(wv, webContentsId, value);
      return res.ok
        ? `Typed "${value}" into element ${id} (${res.detail})`
        : `Typing FAILED: ${res.detail}. Take a browser_screenshot to re-label the page and retry.`;
    }

    if (key) {
      const st: 'press' | 'down' | 'up' = state === 'up' ? 'up' : state === 'down' ? 'down' : 'press';
      const r = await sendKey(webContentsId, key, modifiers, st);
      if (r && r.success === false) return `Key press failed: ${r.error}`;
      return `Pressed ${key} on element ${id}`;
    }
    return 'No key specified for keyboard action';
  }

  return `Unknown action "${action}"`;
};

// Dedicated scrolling tool for the embedded browser.
// Strategy: real wheel event first (keeps lazy-load/infinite-scroll pages
// honest), then VERIFY the page actually moved — synthetic wheel events are
// silently swallowed by some pages/layouts — falling back to programmatic
// window.scrollBy, then to the nearest scrollable container under the cursor.
export const browserScroll = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const webContentsId = wv.getWebContentsId();
  const dir = String(args.direction || args.Direction || 'down').toLowerCase();
  const amount = Number(args.amount ?? args.Amount ?? 600) || 600;
  const id = args.id ?? args.Id;
  const hasId = id !== undefined && id !== null && id !== '';

  // Absolute jumps bypass wheel physics so they always land exactly.
  if (dir === 'top' || dir === 'bottom') {
    if (hasId) {
      const intoView = await wv.executeJavaScript(
        `(() => { const el = window.__oneagentElements[${Number(id)}]; if (!el || !el.isConnected) return false; el.scrollIntoView({ block: '${dir === 'top' ? 'start' : 'end'}', behavior: 'instant' }); return true; })()`
      );
      if (!intoView) return `Element ${id} not found — take a browser_observe to re-label the page and retry`;
    } else {
      await wv.executeJavaScript(
        `window.scrollTo({ top: ${dir === 'top' ? '0' : 'document.documentElement.scrollHeight'}, behavior: 'instant' }); true`
      );
    }
    await new Promise(res => setTimeout(res, 300));
    const pos = await formatScrollState(wv);
    return `Scrolled to ${dir}${hasId ? ` of element ${id}` : ' of page'}${pos ? ` — ${pos}` : ''}`;
  }

  const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
  const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;

  let x: number, y: number;
  if (hasId) {
    const c = await getElementCenter(wv, Number(id));
    if (!c) return `Element ${id} not found — take a browser_observe to re-label the page and retry`;
    ({ x, y } = c);
  } else {
    ({ x, y } = await wv.executeJavaScript(`({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })`));
  }

  const before = await readScrollPos(wv);

  // Attempt 1: real wheel event at the target point.
  const r = await sendInputEvent({ webContentsId, type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  if (!r || r.success !== false) {
    await new Promise(res => setTimeout(res, 300));
    const afterWheel = await readScrollPos(wv);
    if (scrollMoved(before, afterWheel)) {
      const pos = await formatScrollState(wv);
      return `Scrolled ${dir} ${amount}px${hasId ? ` at element ${id}` : ''}${pos ? ` — now at ${pos}` : ''}`;
    }
  }

  // Attempt 2: programmatic window scroll (fires scroll events, so
  // IntersectionObserver lazy-loading still triggers).
  await wv.executeJavaScript(`window.scrollBy(${dx}, ${dy}); true`);
  await new Promise(res => setTimeout(res, 250));
  const afterWin = await readScrollPos(wv);
  if (scrollMoved(before, afterWin)) {
    const pos = await formatScrollState(wv);
    return `Scrolled ${dir} ${amount}px${hasId ? ` at element ${id}` : ''} (direct scroll — wheel had no effect)${pos ? ` — now at ${pos}` : ''}`;
  }

  // Attempt 3: deepest scrollable container under the target point
  // (pages that lock <body> and scroll an inner overflow div).
  const containerHit = await wv.executeJavaScript(`(() => {
    let node = document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node);
      const vOK = /(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const hOK = /(auto|scroll)/.test(cs.overflowX) && node.scrollWidth > node.clientWidth + 1;
      if (vOK || hOK) { node.scrollBy(${dx}, ${dy}); return true; }
      node = node.parentElement;
    }
    return false;
  })()`);
  await new Promise(res => setTimeout(res, 250));
  const afterContainer = await readScrollPos(wv);
  if (containerHit || scrollMoved(afterWin, afterContainer)) {
    const pos = await formatScrollState(wv);
    return `Scrolled ${dir} ${amount}px${hasId ? ` at element ${id}` : ''} (inner scroll container — page body does not scroll)${pos ? ` — now at ${pos}` : ''}`;
  }

  const stuck = await formatScrollState(wv);
  return `Could not scroll ${dir}: no movement (wheel ignored, window/inner containers at their limit or non-scrollable)${stuck ? ` — ${stuck}` : ''}`;
};

interface ScrollPos { x: number; y: number; maxX: number; maxY: number }

// Raw post-scroll geometry of the main scroller.
const readScrollPos = async (wv: any): Promise<ScrollPos | null> => {
  try {
    const s = await wv.executeJavaScript(`(() => {
      const d = document.scrollingElement || document.documentElement;
      return { x: Math.round(d.scrollLeft), y: Math.round(d.scrollTop), maxX: Math.round(d.scrollWidth - d.clientWidth), maxY: Math.round(d.scrollHeight - d.clientHeight) };
    })()`);
    return s && typeof s.y === 'number' ? s : null;
  } catch {
    return null;
  }
};

// True when either axis moved at least 1px between two readings.
const scrollMoved = (a: ScrollPos | null, b: ScrollPos | null): boolean => {
  if (!a || !b) return false;
  return Math.abs(b.y - a.y) >= 1 || Math.abs(b.x - a.x) >= 1;
};

// Human-readable position report so the model knows whether more page remains.
const formatScrollState = async (wv: any): Promise<string | null> => {
  const s = await readScrollPos(wv);
  if (!s) return null;
  const vPart = s.maxY <= 0
    ? 'vertical: fits viewport'
    : `y=${s.y}/${s.maxY}px${s.y >= s.maxY - 2 ? ' [at bottom]' : s.y <= 2 ? ' [at top]' : ''}`;
  const hPart = s.maxX > 0 ? `, x=${s.x}/${s.maxX}px` : '';
  return `${vPart}${hPart}`;
};

// Dedicated, model-friendly typing tool: focuses the field (optionally by
// clicking a Set-of-Mark element), clears existing content, types, verifies
// the text appeared, and optionally submits with Enter.
export const browserType = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const webContentsId = wv.getWebContentsId();
  const text = args.text || args.Text || args.value || args.Value || '';
  if (!text) throw new Error("browser_type requires the 'text' parameter");
  const id = args.id ?? args.Id;
  const submit = !!(args.submit ?? args.Submit ?? args.pressEnter);

  if (id !== undefined && id !== null && id !== '') {
    const coords = await clickElementCenter(wv, Number(id), true);
    if (!coords) {
      return `Element ${id} not found — take a browser_screenshot to re-label the page and retry`;
    }
    await sendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await sendInputEvent({ webContentsId, type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  }
  await new Promise(r => setTimeout(r, 120));

  // Replace any existing content: select-all + delete
  await sendKey(webContentsId, 'a', ['control']);
  await new Promise(r => setTimeout(r, 60));
  await sendKey(webContentsId, 'Delete');
  await new Promise(r => setTimeout(r, 60));

  const res = await typeTextIntoFocus(wv, webContentsId, text);
  if (!res.ok) {
    return `Typing FAILED: ${res.detail}. Take a browser_screenshot to re-label the page and retry.`;
  }

  if (submit) {
    await sendKey(webContentsId, 'Enter');
    await new Promise(r => setTimeout(r, 300));
    return `Typed "${text}" (${res.detail}) and pressed Enter to submit.`;
  }
  return `Typed "${text}" into the field (${res.detail}).`;
};

export const executeBrowserNavigation = async (action: string, url?: string): Promise<string> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  switch (action) {
    case 'navigate': {
      if (!url) break;
      // Navigating to the URL currently loading/loaded aborts the in-flight
      // request (ERR_ABORTED) — treat as success instead.
      try {
        if (wv.getURL() === url || wv.isLoading()) {
          wv.stop();
        }
      } catch {}
      if (wv.getURL() !== url) {
        // Swallow rejections: ERR_ABORTED here means a navigation was
        // superseded, which is expected during rapid agent driving.
        // The synchronous throw ("must be attached to the DOM") happens if the
        // webview is torn down between acquisition and this call.
        try {
          Promise.resolve(wv.loadURL(url)).catch(() => {});
        } catch {}
      }
      // Wait for the page to settle so a following browser_get_dom reads
      // the finished page instead of racing the load.
      const start = Date.now();
      while (Date.now() - start < 15000) {
        try {
          if (!wv.isLoading()) {
            patchTabUrlForWebview(wv);
            return "Navigation complete: " + wv.getURL();
          }
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }
      patchTabUrlForWebview(wv);
      return "Navigation still in progress after 15s: " + wv.getURL();
    }
    case 'back':
      wv.goBack();
      break;
    case 'forward':
      wv.goForward();
      break;
    case 'reload':
      wv.reload();
      break;
    default:
      throw new Error("Unknown browser action");
  }
  return "OK";
};

// Maps a proxied tab back to its id and records the new URL.
const patchTabUrlForWebview = (wv: any) => {
  if (!wv?.__tabId) return;
  try { agentBrowserStore.patchTab(wv.__tabId, { url: wv.getURL(), loading: false }); } catch {}
};

// Full reset (user trash button): AgentBrowser recreates its home view on the
// recreate event. Kept as an event so the chrome stays the single owner of
// tab lifecycle.
export const remountWebview = (): void => {
  window.dispatchEvent(new Event('oneagent-browser-recreate'));
};

// Kills browser sessions. Actor-aware: a sub-agent's browser_terminate closes
// only ITS OWN tab; the user's trash button (no actor) closes everything.
export const terminateBrowserSession = async (): Promise<void> => {
  const actor = getCurrentActor();
  if (actor) {
    const tabId = agentBrowserStore.getTabIdForAgent(actor);
    if (tabId) {
      void (window as any).electronAPI.tabClose(tabId);
      agentBrowserStore.closeTab(tabId);
    }
    return;
  }
  const wv = getActiveWebview();
  void wv;
  // Capture the final frame of the active session for the grayscale overlay.
  try {
    const activeId = agentBrowserStore.getActiveId();
    const st = activeId ? await api().tabState(activeId) : null;
    if (st) {
      const res = await (window as any).electronAPI?.browserCapture?.(activeId);
      if (res?.success && res.image) agentBrowserStore.setTerminatedSnapshot(res.image);
    }
  } catch {}
  remountWebview();
};

export const executeBrowserTerminate = async (): Promise<string> => {
  await terminateBrowserSession();
  return "Browser terminated. The session has been stopped and reset to a blank page. The next browser tool call will start a fresh session.";
};

// ─── Virtual input primitives ────────────────────────────────────────────────
// Fine-grained keyboard/mouse building blocks used by the modern tool set.
// Every positional tool accepts a Set-of-Mark id (preferred) or viewport x/y.

// Resolves a tool target to viewport coordinates: Set-of-Mark id → element
// center (scrolled into view), otherwise validates raw coordinates.
const resolveTargetPoint = async (
  wv: any,
  id?: number | null,
  x?: number | null,
  y?: number | null
): Promise<{ x: number, y: number } | null> => {
  let targetX: number | undefined, targetY: number | undefined;
  if (id !== undefined && id !== null) {
    const c = await getElementCenter(wv, Number(id));
    if (!c) return null;
    targetX = c.x;
    targetY = c.y;
  } else {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
    targetX = Math.round(nx);
    targetY = Math.round(ny);
  }

  const code = `
    (function() {
      return new Promise((resolve) => {
        const targetX = ${targetX};
        const targetY = ${targetY};
        let computedCursor = 'default';
        try {
          const el = document.elementFromPoint(targetX, targetY);
          if (el) computedCursor = window.getComputedStyle(el).cursor;
          // Editable targets always get the I-beam — pages often restyle
          // inputs with custom cursors that would hide it.
          if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA'].includes(el.tagName))) {
            const editableEl = el.closest('input, textarea, [contenteditable="true"], [contenteditable=""]') || el;
            if (editableEl && (editableEl.isContentEditable || ['INPUT', 'TEXTAREA'].includes(editableEl.tagName))) {
              computedCursor = 'text';
            }
          }
        } catch(e) {}
        
        let svgContent = '';
        if (computedCursor === 'pointer') {
          svgContent = '<svg width="32" height="40" viewBox="0 0 24 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 1L12 15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 5V15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 8V15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 7V17" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 17L5.5 15.5C4 14.5 2 15.5 2.5 17L5 22C6 24 8 26 10 27C12 28 16 28 18 26C20 24 21 21 21 18V13.5C21 11.5 19 11.5 19 13.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 17L5.5 15.5C4 14.5 2 15.5 2.5 17L5 22C6 24 8 26 10 27C12 28 16 28 18 26C20 24 21 21 21 18V13.5C21 11.5 19 11.5 19 13.5" fill="black"/></svg>';
        } else if (computedCursor === 'text') {
          svgContent = '<svg width="24" height="40" viewBox="0 0 16 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3H13M8 3V29M3 29H13" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4H12M8 4V28M4 28H12" stroke="black" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        } else {
          svgContent = '<svg width="32" height="48" viewBox="0 0 24 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.65376 2.15376C5.42103 1.92103 5.06847 1.8385 4.75338 1.94314C4.4383 2.04778 4.22019 2.31885 4.19702 2.65171L2.03035 33.8517C2.00844 34.1673 2.1969 34.4636 2.49603 34.5843C2.79517 34.7049 3.13653 34.6231 3.34032 34.3813L10.3704 26.0355L16.2731 34.8021C16.4805 35.1097 16.8906 35.1884 17.1889 34.978L22.4206 31.2872C22.7188 31.0768 22.7845 30.666 22.5663 30.3621L16.2238 21.5303H24.3333C24.6468 21.5303 24.9312 21.3414 25.0482 21.0558C25.1652 20.7702 25.0906 20.4431 24.8604 20.2319L5.65376 2.15376Z" fill="black" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';
        }

        const cursor = document.createElement('img');
          cursor.src = 'data:image/svg+xml;base64,' + btoa(svgContent);
        Object.assign(cursor.style, {
          position: 'fixed',
          zIndex: '2147483647',
          pointerEvents: 'none',
          transition: 'all 0.6s cubic-bezier(0.25, 1, 0.5, 1)',
          left: window.innerWidth + 'px',
          top: window.innerHeight + 'px',
          transform: 'translate(-4px, -4px)',
          filter: 'drop-shadow(1px 2px 3px rgba(0,0,0,0.4))'
        });
        document.documentElement.appendChild(cursor);

        setTimeout(() => {
          cursor.style.left = targetX + 'px';
          cursor.style.top = targetY + 'px';
        }, 50);

        setTimeout(() => {
          cursor.style.transform = 'translate(-4px, -4px) scale(0.8)';
          setTimeout(() => cursor.style.transform = 'translate(-4px, -4px) scale(1)', 150);

          setTimeout(() => {
            cursor.style.opacity = '0';
            setTimeout(() => {
              cursor.remove();
              resolve(null);
            }, 300);
          }, 300);
        }, 650);
      });
    })();
  `;
  try {
    await wv.executeJavaScript(code);
  } catch(e) {}

  return { x: targetX, y: targetY };
};

const notFoundMsg = (id?: number | null) =>
  `${id !== undefined && id !== null ? `Element ${id}` : 'Target'} not found or out of view — take a browser_observe to re-label the page and retry`;

const mouseButtonEvent = async (
  webContentsId: number,
  type: string,
  x: number,
  y: number,
  opts: { button?: string, clickCount?: number, modifiers?: string[] } = {}
) => {
  const r = await sendInputEvent({
    webContentsId,
    type,
    x,
    y,
    button: opts.button || 'left',
    clickCount: opts.clickCount ?? 1,
    modifiers: opts.modifiers || []
  });
  return r && r.success === false ? r : { success: true };
};

export const browserClick = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const webContentsId = wv.getWebContentsId();

  const id = args.id ?? args.Id;
  const coords = await resolveTargetPoint(wv, id, args.x ?? args.X, args.y ?? args.Y);
  if (!coords) return notFoundMsg(id);

  const button = args.button || args.Button || 'left';
  const modifiers = args.modifiers || args.Modifiers || [];
  let count = Number(args.click_count ?? args.ClickCount ?? 1);
  if (!Number.isFinite(count) || count < 1) count = 1;
  if (args.double ?? args.Double) count = Math.max(count, 2);
  count = Math.min(3, Math.max(1, Math.round(count)));

  // Move cursor to target first — some pages only respond to clicks after hover
  await sendInputEvent({ webContentsId, type: 'mouseMove', x: coords.x, y: coords.y });
  await new Promise(r => setTimeout(r, 30));

  for (let c = 1; c <= count; c++) {
    await mouseButtonEvent(webContentsId, 'mouseDown', coords.x, coords.y, { button, clickCount: c, modifiers });
    await new Promise(r => setTimeout(r, 50));
    await mouseButtonEvent(webContentsId, 'mouseUp', coords.x, coords.y, { button, clickCount: c, modifiers });
    await new Promise(r => setTimeout(r, 60));
  }
  return `Clicked ${button} x${count} at (${coords.x}, ${coords.y})${id != null ? ` on element ${id}` : ''}`;
};

// phase: 'down' presses and holds; 'up' releases.
export const browserHold = async (args: any, phase: 'down' | 'up'): Promise<string> => {
  const wv = await waitForActiveWebview();
  const webContentsId = wv.getWebContentsId();

  // Release may omit position entirely — release at current cursor location.
  const needsPoint = phase === 'down' || args.id != null || args.x != null || args.y != null;
  const button = args.button || args.Button || 'left';

  if (needsPoint) {
    const coords = await resolveTargetPoint(wv, args.id ?? args.Id, args.x ?? args.X, args.y ?? args.Y);
    if (!coords) return notFoundMsg(args.id ?? args.Id);
    const r = await mouseButtonEvent(webContentsId, phase === 'down' ? 'mouseDown' : 'mouseUp', coords.x, coords.y, { button });
    if (r.success === false) return `${phase} failed: ${r.error}`;
    return `Mouse ${phase} ${button} at (${coords.x}, ${coords.y})`;
  }

  // Position-less release: nudge event through at last known center.
  const r = await sendInputEvent({ webContentsId, type: 'mouseUp', button, clickCount: 1 });
  if (r && r.success === false) return `Release failed: ${r.error}`;
  return `Mouse up ${button} released`;
};

export const browserMove = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const webContentsId = wv.getWebContentsId();

  const coords = await resolveTargetPoint(wv, args.id ?? args.Id, args.x ?? args.X, args.y ?? args.Y);
  if (!coords) return notFoundMsg(args.id ?? args.Id);
  const r = await sendInputEvent({ webContentsId, type: 'mouseMove', x: coords.x, y: coords.y });
  if (r && r.success === false) return `Move failed: ${r.error}`;
  return `Cursor moved to (${coords.x}, ${coords.y})${args.id != null ? ` over element ${args.id}` : ''}`;
};

export const browserDragTo = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const webContentsId = wv.getWebContentsId();

  const fromCoords = await resolveTargetPoint(wv, args.from_id ?? args.FromId, args.from_x ?? args.FromX, args.from_y ?? args.FromY);
  if (!fromCoords) return notFoundMsg(args.from_id ?? args.FromId);

  let toCoords = await resolveTargetPoint(wv, args.to_id ?? args.ToId, args.to_x ?? args.ToX, args.to_y ?? args.ToY);
  if (!toCoords) return notFoundMsg(args.to_id ?? args.ToId);

  const button = args.button || args.Button || 'left';
  await sendInputEvent({ webContentsId, type: 'mouseMove', x: fromCoords.x, y: fromCoords.y });
  await new Promise(r => setTimeout(r, 80));
  await mouseButtonEvent(webContentsId, 'mouseDown', fromCoords.x, fromCoords.y, { button });
  await new Promise(r => setTimeout(r, 150));

  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const ix = Math.round(fromCoords.x + (toCoords.x - fromCoords.x) * i / steps);
    const iy = Math.round(fromCoords.y + (toCoords.y - fromCoords.y) * i / steps);
    await sendInputEvent({ webContentsId, type: 'mouseMove', x: ix, y: iy });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 100));
  await mouseButtonEvent(webContentsId, 'mouseUp', toCoords.x, toCoords.y, { button });
  return `Dragged (${fromCoords.x}, ${fromCoords.y}) → (${toCoords.x}, ${toCoords.y})`;
};

export const browserPressKey = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const webContentsId = wv.getWebContentsId();

  const key = normalizeKeyCode(args.key || args.Key || '');
  if (!key) throw new Error("browser_key requires the 'key' parameter");
  const modifiers = args.modifiers || args.Modifiers || [];
  const state: 'press' | 'down' | 'up' = args.state === 'down' || args.State === 'down' ? 'down'
    : args.state === 'up' || args.State === 'up' ? 'up' : 'press';

  const r = await sendKey(webContentsId, key, modifiers, state);
  if (r && r.success === false) return `Key press failed: ${r.error}`;
  return state === 'press'
    ? `Pressed ${key}${modifiers.length ? ` with ${modifiers.join('+')}` : ''}`
    : `Key ${key} ${state}`;
};

// Runs JS in the page. Accepts a bare expression ("document.title") or a body
// starting with "return". Result must be JSON-serializable — DOM nodes are
// rejected by IPC serialization and surface as an honest error.
export const browserEvaluateScript = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const script = String(args.script || args.Script || args.code || '').trim();
  if (!script) throw new Error("browser_evaluate requires the 'script' parameter");
  const timeoutMs = Number(args.timeout_ms ?? args.TimeoutMs ?? 15000) || 15000;

  const wrapped = /^return\b/.test(script)
    ? `(async () => { try { ${script} } catch(e) { return { __isError: true, message: e.message || String(e) }; } })()`
    : `(async () => { try { return (${script}); } catch(e) { return { __isError: true, message: e.message || String(e) }; } })()`;

  let timer: any = null;
  try {
    const value = await Promise.race([
      wv.executeJavaScript(wrapped),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`evaluation timed out after ${timeoutMs}ms`)), timeoutMs); })
    ]);
    if (value && typeof value === 'object' && (value as any).__isError) {
      return `Execution error: ${(value as any).message}`;
    }
    let out: string;
    try {
      out = value === undefined ? 'undefined' : JSON.stringify(value);
      if (out.length > 8000) out = out.slice(0, 8000) + `…[truncated ${out.length - 8000} chars]`;
    } catch {
      out = String(value);
    }
    return `Result: ${out}`;
  } catch (err: any) {
    return `Execution error: ${err.message || err}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// Selects an <option> on a Set-of-Mark <select>, matching by value first then
// visible label. Fires input+change so React/Vue apps register it.
export const browserSelectOptionById = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const id = Number(args.id ?? args.Id);
  const value = String(args.value ?? args.Value ?? '');
  if (!id || !value) throw new Error("browser_select_option requires 'id' and 'value'");

  const code = `
    (function() {
      var el = window.__oneagentElements && window.__oneagentElements[${id}];
      if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'no select element with that id' };
      if (!el.isConnected) { delete window.__oneagentElements[${id}]; return { ok: false, reason: 'element left the page — re-observe for a fresh id' }; }
      var wanted = ${JSON.stringify(value)};
      var opt = Array.from(el.options).find(o => o.value === wanted)
             || Array.from(el.options).find(o => (o.textContent || '').trim().toLowerCase() === wanted.toLowerCase());
      if (!opt) return { ok: false, reason: 'option not found', options: Array.from(el.options).slice(0, 40).map(o => ({ value: o.value, label: (o.textContent || '').trim() })) };
      var setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(el, opt.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: { value: opt.value, label: (opt.textContent || '').trim() } };
    })()
  `;
  const res = await wv.executeJavaScript(code);
  if (!res?.ok) {
    const opts = res?.options?.map((o: any) => `"${o.value}" (${o.label})`).join(', ') || '';
    return `Selection failed: ${res?.reason}${opts ? `. Available options: ${opts}` : ''}`;
  }
  return `Selected "${res.selected.value}" (${res.selected.label}) on element ${id}`;
};

// Waits until a CSS selector exists in the page OR given text appears anywhere.
// Polls cheaply instead of forcing screenshot loops.
export const browserWaitForTextOrSelector = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const target = String(args.selector_or_text || args.SelectorOrText || args.selector || args.text || '');
  if (!target) throw new Error("browser_wait_for requires 'selector_or_text'");
  const timeoutMs = Math.min(30000, Number(args.timeout_ms ?? args.TimeoutMs ?? 8000) || 8000);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (!wv.isLoading()) {
        const found = await wv.executeJavaScript(`(function(){
          var t = ${JSON.stringify(target)};
          try { if (document.querySelector(t)) return 'selector'; } catch (e) {}
          if ((document.body && document.body.innerText || '').includes(t.replace(/\\\\n/g, '\\n'))) return 'text';
          return '';
        })()`);
        if (found === 'selector') return `Found selector "${target}" after ${Date.now() - start}ms`;
        if (found === 'text') return `Found text "${target}" after ${Date.now() - start}ms`;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return `Not found within ${timeoutMs}ms: "${target}". Take a browser_observe to check what the page actually shows.`;
};

// Overrides / resets the embedded browser's User-Agent string.
export const browserSetUserAgent = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const win = window as any;
  if (!win.__oneagentDefaultUA) win.__oneagentDefaultUA = wv.getUserAgent?.() || '';
  const ua = String(args.ua ?? args.Ua ?? args.userAgent ?? args.UserAgent ?? '').trim();
  if (!ua) {
    if (win.__oneagentDefaultUA) wv.setUserAgent(win.__oneagentDefaultUA);
    return 'User-Agent reset to default.';
  }
  wv.setUserAgent(ua);
  return `User-Agent set to: ${ua}`;
};

// One-call page observation: annotated screenshot + Set-of-Mark list + trimmed
// DOM text. The default way for the agent to look at a page.
export const browserObservePage = async (): Promise<{ image: string, markers: any[], dom: string, meta: any }> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const shot = await captureBrowserScreenshot();
  let dom = '';
  try {
    dom = (await getSemanticDOM()).substring(0, 6000);
  } catch {}

  // Collect viewport & scroll metadata to help the model understand page state
  let meta: any = {};
  try {
    const scrollInfo = await wv.executeJavaScript(`(function() {
      const d = document.scrollingElement || document.documentElement;
      const vp = { width: window.innerWidth, height: window.innerHeight };
      const scroll = { x: Math.round(d.scrollLeft), y: Math.round(d.scrollTop) };
      const max = { x: Math.round(d.scrollWidth - d.clientWidth), y: Math.round(d.scrollHeight - d.clientHeight) };
      return {
        url: window.location.href,
        title: document.title,
        viewport: vp,
        scroll,
        maxScroll: max,
        atTop: scroll.y <= 0,
        atBottom: scroll.y >= max.y - 1,
        atLeft: scroll.x <= 0,
        atRight: scroll.x >= max.x - 1,
        scrollPercent: max.y > 0 ? Math.round((scroll.y / max.y) * 100) : 0
      };
    })()`);
    meta = scrollInfo;
  } catch {}

  return { image: shot.image, markers: shot.markers, dom, meta };
};

// Legacy mega-tool kept for old conversation replays. Routes onto the modern
// primitives so both paths share one implementation.
export const browserKeystrokesLegacyRouter = async (args: any): Promise<string> => {
  const action = (args.action || args.Action || 'click').toLowerCase();
  const id = args.id ?? args.Id;
  switch (action) {
    case 'scroll':
      return browserScroll(args);
    case 'drag':
      return browserDragTo({
        from_id: id,
        to_id: args.targetId ?? args.TargetId ?? args.toId,
        to_x: args.x ?? args.X,
        to_y: args.y ?? args.Y,
        button: args.button || args.Button
      });
    case 'type':
      return browserType({ text: args.value || args.Value || args.text || args.Text, id, submit: false });
    case 'keyboard':
      return browserPressKey({ key: args.key || args.Key, modifiers: args.modifiers || args.Modifiers, state: args.state || args.State });
    case 'mouse':
    case 'click':
    default: {
      const st = args.state || args.State || 'click';
      if (st === 'down') return browserHold(args, 'down');
      if (st === 'up') return browserHold(args, 'up');
      if (st === 'move' || st === 'hover') return browserMove(args);
      return browserClick({ id, button: args.button || args.Button, modifiers: args.modifiers || args.Modifiers });
    }
  }
};