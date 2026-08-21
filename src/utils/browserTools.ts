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

  // If a navigation is in flight (e.g. after browser_interact click), let it
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
        // Very basic semantic extraction
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
          acceptNode: function(node) {
            try {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const tag = node.tagName.toLowerCase();
                if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return NodeFilter.FILTER_REJECT;
                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
              }
              return NodeFilter.FILTER_ACCEPT;
            } catch (e) {
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        });

        let result = '';
        let currentNode = walker.nextNode();
        while(currentNode) {
          if (currentNode.nodeType === Node.TEXT_NODE) {
            const text = currentNode.textContent.trim();
            if (text) result += text + ' ';
          } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
            const tag = currentNode.tagName.toLowerCase();
            if (['p', 'div', 'section', 'article', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'].includes(tag)) {
              result += '\\n';
            }
            if (tag === 'a' && currentNode.href) {
              result += '[' + currentNode.textContent.trim() + '](' + currentNode.href + ') ';
            }
          }
          currentNode = walker.nextNode();
        }
        // Collapse blank lines without regex backtracking over huge inputs
        const cleaned = result.split('\\n').map(s => s.trim()).filter(Boolean).join('\\n');
        return cleaned.substring(0, 20000);
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

export const interactWithElement = async (args: any): Promise<boolean> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const id = args.id || args.Id || 0;
  const action = args.action || args.Action || 'click';
  const state = args.state || args.State || 'click';
  const button = args.button || args.Button || 'left';
  const key = args.key || args.Key || '';
  const modifiers = args.modifiers || args.Modifiers || [];
  const value = args.value || args.Value || '';

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
          
          // Create standard arrow cursor
          const cursor = document.createElement('div');
          cursor.innerHTML = '<svg width="24" height="36" viewBox="0 0 24 36" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.65376 2.15376C5.42103 1.92103 5.06847 1.8385 4.75338 1.94314C4.4383 2.04778 4.22019 2.31885 4.19702 2.65171L2.03035 33.8517C2.00844 34.1673 2.1969 34.4636 2.49603 34.5843C2.79517 34.7049 3.13653 34.6231 3.34032 34.3813L10.3704 26.0355L16.2731 34.8021C16.4805 35.1097 16.8906 35.1884 17.1889 34.978L22.4206 31.2872C22.7188 31.0768 22.7845 30.666 22.5663 30.3621L16.2238 21.5303H24.3333C24.6468 21.5303 24.9312 21.3414 25.0482 21.0558C25.1652 20.7702 25.0906 20.4431 24.8604 20.2319L5.65376 2.15376Z" fill="black" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';
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

          // Animate
          setTimeout(() => {
            cursor.style.left = targetX + 'px';
            cursor.style.top = targetY + 'px';
          }, 50);

          setTimeout(() => {
            // Click effect
            cursor.style.transform = 'translate(-4px, -4px) scale(0.8)';
            setTimeout(() => cursor.style.transform = 'translate(-4px, -4px) scale(1)', 150);

            if ('${action}' === 'type' || '${action}' === 'keyboard') {
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
  const coords = await wv.executeJavaScript(code);
  if (!coords) return false;

  const electronAPI = (window as any).electronAPI;
  const webContentsId = wv.getWebContentsId();

  if (action === 'mouse' || action === 'click' || action === 'scroll') {
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
  } else if (action === 'keyboard' || action === 'type') {
    // Focus first
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseDown', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));
    await electronAPI.browserSendInputEvent({ webContentsId, type: 'mouseUp', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 50));

    if (action === 'type' && value) {
      await electronAPI.browserInsertText({ webContentsId, text: value });
    } else if (key) {
      let type = 'keyDown';
      if (state === 'up') type = 'keyUp';
      
      if (state === 'press' || state === 'click') {
        await electronAPI.browserSendInputEvent({ webContentsId, type: 'keyDown', keyCode: key, modifiers });
        await new Promise(r => setTimeout(r, 50));
        await electronAPI.browserSendInputEvent({ webContentsId, type: 'keyUp', keyCode: key, modifiers });
      } else {
        await electronAPI.browserSendInputEvent({ webContentsId, type, keyCode: key, modifiers });
      }
    }
  }

  return true;
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
