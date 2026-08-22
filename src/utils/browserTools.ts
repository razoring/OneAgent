import { agentBrowserStore } from './agentBrowserStore';

export const getActiveWebview = () => (window as any).activeWebview;

// The live webview mounts inside the latest browser tool call block, which can
// land a beat after the agent's first browser_* call arrives — poll briefly.
export const waitForActiveWebview = async (timeoutMs = 5000): Promise<any> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const wv = (window as any).activeWebview;
    if (wv) return wv;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("No active webview available");
};

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
      let nextId = 1;

      elements.forEach(el => {
        // Skip hidden elements
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const id = nextId++;
        
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
        Object.assign(marker.style, {
          position: 'absolute',
          top: (window.scrollY + rect.top) + 'px',
          left: (window.scrollX + rect.left) + 'px',
          background: 'rgba(255, 0, 0, 0.8)',
          color: 'white',
          fontSize: '12px',
          fontWeight: 'bold',
          padding: '2px 4px',
          borderRadius: '4px',
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
          border: '2px dashed rgba(255, 0, 0, 0.8)',
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
          text: (el.textContent || el.value || el.alt || '').trim().substring(0, 50),
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
  const electronAPI = (window as any).electronAPI;
  if (state === 'down' || state === 'press') {
    const r = await electronAPI.browserSendInputEvent({ webContentsId, type: 'keyDown', keyCode, modifiers });
    if (r && r.success === false) return r;
  }
  if (state === 'up' || state === 'press') {
    await new Promise(r => setTimeout(r, 40));
    const r = await electronAPI.browserSendInputEvent({ webContentsId, type: 'keyUp', keyCode, modifiers });
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
      const r = await electronAPI.browserSendInputEvent({ webContentsId, type: 'char', keyCode: ch });
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
        if (!el) {
          resolve(null);
          return;
        }

        try {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const rect = el.getBoundingClientRect();
          const targetX = Math.round(rect.left + rect.width / 2);
          const targetY = Math.round(rect.top + rect.height / 2);

          const computedCursor = window.getComputedStyle(el).cursor;
          let svgContent = '';
          if (computedCursor === 'pointer') {
            svgContent = '<svg width="32" height="40" viewBox="0 0 24 30" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 1L12 15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 5V15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 8V15" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 7V17" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 17L5.5 15.5C4 14.5 2 15.5 2.5 17L5 22C6 24 8 26 10 27C12 28 16 28 18 26C20 24 21 21 21 18V13.5C21 11.5 19 11.5 19 13.5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 17L5.5 15.5C4 14.5 2 15.5 2.5 17L5 22C6 24 8 26 10 27C12 28 16 28 18 26C20 24 21 21 21 18V13.5C21 11.5 19 11.5 19 13.5" fill="black"/></svg>';
          } else if (computedCursor === 'text') {
            svgContent = '<svg width="24" height="40" viewBox="0 0 16 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3H13M8 3V29M3 29H13" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4H12M8 4V28M4 28H12" stroke="black" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          } else {
            svgContent = '<svg width="32" height="48" viewBox="0 0 24 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.65376 2.15376C5.42103 1.92103 5.06847 1.8385 4.75338 1.94314C4.4383 2.04778 4.22019 2.31885 4.19702 2.65171L2.03035 33.8517C2.00844 34.1673 2.1969 34.4636 2.49603 34.5843C2.79517 34.7049 3.13653 34.6231 3.34032 34.3813L10.3704 26.0355L16.2731 34.8021C16.4805 35.1097 16.8906 35.1884 17.1889 34.978L22.4206 31.2872C22.7188 31.0768 22.7845 30.666 22.5663 30.3621L16.2238 21.5303H24.3333C24.6468 21.5303 24.9312 21.3414 25.0482 21.0558C25.1652 20.7702 25.0906 20.4431 24.8604 20.2319L5.65376 2.15376Z" fill="black" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';
          }

          const cursor = document.createElement('img');
          cursor.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgContent);
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

// Quick viewport-center lookup for a Set-of-Mark element (no cursor animation).
export const getElementCenter = async (wv: any, id: number): Promise<{ x: number, y: number } | null> =>
  wv.executeJavaScript(`(function(){
    var el = window.__oneagentElements && window.__oneagentElements[${id}];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    var r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

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

  const electronAPI = (window as any).electronAPI;
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
    const r = await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
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

    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseMove', x: coords.x, y: coords.y });
    await new Promise(r => setTimeout(r, 80));
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button, clickCount: 1 });
    await new Promise(r => setTimeout(r, 150));

    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const ix = Math.round(coords.x + ((tx as number) - coords.x) * i / steps);
      const iy = Math.round(coords.y + ((ty as number) - coords.y) * i / steps);
      await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseMove', x: ix, y: iy });
      await new Promise(r => setTimeout(r, 30));
    }
    await new Promise(r => setTimeout(r, 100));
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseUp', x: tx as number, y: ty as number, button, clickCount: 1 });
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
      await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button, clickCount: 1, modifiers });
      await new Promise(r => setTimeout(r, 50));
      await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseUp', x: coords.x, y: coords.y, button, clickCount: 1, modifiers });
    } else {
      await electronAPI.browserSendInputEvent({ webContentsId, type, x: coords.x, y: coords.y, button, clickCount: 1, modifiers });
    }
    return `${state === 'click' ? 'Clicked' : state} element ${id} at (${coords.x}, ${coords.y})`;
  }

  if (action === 'keyboard' || action === 'type') {
    // Focus first
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
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

// Dedicated wheel-scrolling tool for the embedded browser. Relative
// directions ride real wheel events (keeps lazy-load/infinite-scroll pages
// honest); "top"/"bottom" jump absolutely via scrollTo/scrollIntoView.
export const browserScroll = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const electronAPI = (window as any).electronAPI;
  const webContentsId = wv.getWebContentsId();
  const dir = String(args.direction || args.Direction || 'down').toLowerCase();
  const amount = Number(args.amount ?? args.Amount ?? 600) || 600;
  const id = args.id ?? args.Id;
  const hasId = id !== undefined && id !== null && id !== '';

  // Absolute jumps bypass wheel physics so they always land exactly.
  if (dir === 'top' || dir === 'bottom') {
    if (hasId) {
      const intoView = await wv.executeJavaScript(
        `(() => { const el = window.__oneagentElements[${Number(id)}]; if (!el) return false; el.scrollIntoView({ block: '${dir === 'top' ? 'start' : 'end'}', behavior: 'instant' }); return true; })()`
      );
      if (!intoView) return `Element ${id} not found — take a browser_observe to re-label the page and retry`;
    } else {
      await wv.executeJavaScript(
        `window.scrollTo({ top: ${dir === 'top' ? '0' : 'document.documentElement.scrollHeight'}, behavior: 'instant' }); true`
      );
    }
    await new Promise(res => setTimeout(res, 300));
    const pos = await readScrollState(wv);
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

  const r = await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  if (r && r.success === false) return `Scroll failed: ${r.error}`;
  await new Promise(res => setTimeout(res, 300));
  const pos = await readScrollState(wv);
  return `Scrolled ${dir} ${amount}px${hasId ? ` at element ${id}` : ''}${pos ? ` — now at ${pos}` : ''}`;
};

// Post-scroll position report so the model knows whether more page remains.
const readScrollState = async (wv: any): Promise<string | null> => {
  try {
    const s = await wv.executeJavaScript(`(() => {
      const d = document.scrollingElement || document.documentElement;
      const max = d.scrollHeight - d.clientHeight;
      return { y: Math.round(d.scrollTop), max: Math.round(max) };
    })()`);
    if (!s) return null;
    if (s.max <= 0) return 'page fits viewport (nothing more to scroll)';
    return `y=${s.y}/${s.max}px${s.y >= s.max - 2 ? ' [at bottom]' : s.y <= 2 ? ' [at top]' : ''}`;
  } catch {
    return null;
  }
};

// Dedicated, model-friendly typing tool: focuses the field (optionally by
// clicking a Set-of-Mark element), clears existing content, types, verifies
// the text appeared, and optionally submits with Enter.
export const browserType = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const electronAPI = (window as any).electronAPI;
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
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
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
        Promise.resolve(wv.loadURL(url)).catch(() => {});
      }
      // Wait for the page to settle so a following browser_get_dom reads
      // the finished page instead of racing the load.
      const start = Date.now();
      while (Date.now() - start < 15000) {
        try {
          if (!wv.isLoading()) {
            agentBrowserStore.navigate(wv.getURL());
            return "Navigation complete: " + wv.getURL();
          }
        } catch {}
        await new Promise(r => setTimeout(r, 150));
      }
      agentBrowserStore.navigate(wv.getURL());
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
  if (id !== undefined && id !== null) {
    return getElementCenter(wv, Number(id));
  }
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  return { x: Math.round(nx), y: Math.round(ny) };
};

const notFoundMsg = (id?: number | null) =>
  `${id !== undefined && id !== null ? `Element ${id}` : 'Target'} not found or out of view — take a browser_observe to re-label the page and retry`;

const mouseButtonEvent = async (
  electronAPI: any,
  webContentsId: number,
  type: string,
  x: number,
  y: number,
  opts: { button?: string, clickCount?: number, modifiers?: string[] } = {}
) => {
  const r = await electronAPI.browserSendInputEvent({
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
  const electronAPI = (window as any).electronAPI;
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

  for (let c = 1; c <= count; c++) {
    await mouseButtonEvent(electronAPI, webContentsId, 'mouseDown', coords.x, coords.y, { button, clickCount: c, modifiers });
    await new Promise(r => setTimeout(r, 50));
    await mouseButtonEvent(electronAPI, webContentsId, 'mouseUp', coords.x, coords.y, { button, clickCount: c, modifiers });
    await new Promise(r => setTimeout(r, 60));
  }
  return `Clicked ${button} x${count} at (${coords.x}, ${coords.y})${id != null ? ` on element ${id}` : ''}`;
};

// phase: 'down' presses and holds; 'up' releases.
export const browserHold = async (args: any, phase: 'down' | 'up'): Promise<string> => {
  const wv = await waitForActiveWebview();
  const electronAPI = (window as any).electronAPI;
  const webContentsId = wv.getWebContentsId();

  // Release may omit position entirely — release at current cursor location.
  const needsPoint = phase === 'down' || args.id != null || args.x != null || args.y != null;
  const button = args.button || args.Button || 'left';

  if (needsPoint) {
    const coords = await resolveTargetPoint(wv, args.id ?? args.Id, args.x ?? args.X, args.y ?? args.Y);
    if (!coords) return notFoundMsg(args.id ?? args.Id);
    const r = await mouseButtonEvent(electronAPI, webContentsId, phase === 'down' ? 'mouseDown' : 'mouseUp', coords.x, coords.y, { button });
    if (r.success === false) return `${phase} failed: ${r.error}`;
    return `Mouse ${phase} ${button} at (${coords.x}, ${coords.y})`;
  }

  // Position-less release: nudge event through at last known center.
  const r = await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseUp', button, clickCount: 1 });
  if (r && r.success === false) return `Release failed: ${r.error}`;
  return `Mouse up ${button} released`;
};

export const browserMove = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const electronAPI = (window as any).electronAPI;
  const webContentsId = wv.getWebContentsId();

  const coords = await resolveTargetPoint(wv, args.id ?? args.Id, args.x ?? args.X, args.y ?? args.Y);
  if (!coords) return notFoundMsg(args.id ?? args.Id);
  const r = await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseMove', x: coords.x, y: coords.y });
  if (r && r.success === false) return `Move failed: ${r.error}`;
  return `Cursor moved to (${coords.x}, ${coords.y})${args.id != null ? ` over element ${args.id}` : ''}`;
};

export const browserDragTo = async (args: any): Promise<string> => {
  const wv = await waitForActiveWebview();
  const electronAPI = (window as any).electronAPI;
  const webContentsId = wv.getWebContentsId();

  const fromCoords = await resolveTargetPoint(wv, args.from_id ?? args.FromId, args.from_x ?? args.FromX, args.from_y ?? args.FromY);
  if (!fromCoords) return notFoundMsg(args.from_id ?? args.FromId);

  let toCoords = await resolveTargetPoint(wv, args.to_id ?? args.ToId, args.to_x ?? args.ToX, args.to_y ?? args.ToY);
  if (!toCoords) return notFoundMsg(args.to_id ?? args.ToId);

  const button = args.button || args.Button || 'left';
  await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseMove', x: fromCoords.x, y: fromCoords.y });
  await new Promise(r => setTimeout(r, 80));
  await mouseButtonEvent(electronAPI, webContentsId, 'mouseDown', fromCoords.x, fromCoords.y, { button });
  await new Promise(r => setTimeout(r, 150));

  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const ix = Math.round(fromCoords.x + (toCoords.x - fromCoords.x) * i / steps);
    const iy = Math.round(fromCoords.y + (toCoords.y - fromCoords.y) * i / steps);
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseMove', x: ix, y: iy });
    await new Promise(r => setTimeout(r, 30));
  }
  await new Promise(r => setTimeout(r, 100));
  await mouseButtonEvent(electronAPI, webContentsId, 'mouseUp', toCoords.x, toCoords.y, { button });
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
    ? `(async () => { ${script} })()`
    : `(async () => { return (${script}); })()`;

  let timer: any = null;
  try {
    const value = await Promise.race([
      wv.executeJavaScript(wrapped),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`evaluation timed out after ${timeoutMs}ms`)), timeoutMs); })
    ]);
    let out: string;
    try {
      out = value === undefined ? 'undefined' : JSON.stringify(value);
      if (out.length > 8000) out = out.slice(0, 8000) + `…[truncated ${out.length - 8000} chars]`;
    } catch {
      out = String(value);
    }
    return `Result: ${out}`;
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
export const browserObservePage = async (): Promise<{ image: string, markers: any[], dom: string }> => {
  const shot = await captureBrowserScreenshot();
  let dom = '';
  try {
    dom = (await getSemanticDOM()).substring(0, 6000);
  } catch {}
  return { image: shot.image, markers: shot.markers, dom };
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
