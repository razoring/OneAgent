export const getActiveWebview = () => (window as any).activeWebview;

// The live webview mounts inside the latest browser tool call block, which can
// land a beat after the agent's first browser_* call arrives — poll briefly.
export const waitForActiveWebview = async (timeoutMs = 5000): Promise<any> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const wv = await waitForActiveWebview();
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
        
        // Create marker
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
          zIndex: '2147483647',
          pointerEvents: 'none',
          boxShadow: '0 0 2px rgba(0,0,0,0.5)',
          lineHeight: '1'
        });
        
        // Draw border around element
        const border = document.createElement('div');
        border.className = 'oneagent-som-marker';
        Object.assign(border.style, {
          position: 'absolute',
          top: (window.scrollY + rect.top) + 'px',
          left: (window.scrollX + rect.left) + 'px',
          width: rect.width + 'px',
          height: rect.height + 'px',
          border: '2px dashed rgba(255, 0, 0, 0.8)',
          zIndex: '2147483646',
          pointerEvents: 'none'
        });

        document.body.appendChild(border);
        document.body.appendChild(marker);

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

  const code = `
    (function() {
      // Very basic semantic extraction
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: function(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
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
      return result.replace(/\\n\\s*\\n/g, '\\n').trim().substring(0, 20000); // Limit to 20k chars
    })();
  `;
  return await wv.executeJavaScript(code);
};

export const clearSetOfMark = async (): Promise<void> => {
  const wv = await waitForActiveWebview();
  if (!wv) return;
  await wv.executeJavaScript(`document.querySelectorAll('.oneagent-som-marker').forEach(e => e.remove());`);
};

export const interactWithElement = async (id: number, action: 'click' | 'type' | 'scroll', value?: string): Promise<boolean> => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  const code = `
    (function() {
      const el = window.__oneagentElements && window.__oneagentElements[${id}];
      if (!el) return false;
      
      try {
        if ('${action}' === 'click') {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.click();
          return true;
        }
        if ('${action}' === 'type') {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.focus();
          el.value = ${JSON.stringify(value || '')};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      } catch(e) {
        console.error(e);
        return false;
      }
      return false;
    })();
  `;
  return await wv.executeJavaScript(code);
};

export const executeBrowserNavigation = async (action: string, url?: string) => {
  const wv = await waitForActiveWebview();
  if (!wv) throw new Error("No active webview available");

  switch (action) {
    case 'navigate':
      if (url) wv.loadURL(url);
      break;
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
};
