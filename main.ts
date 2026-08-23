import { app, BrowserWindow, ipcMain, nativeImage, shell, desktopCapturer, screen, webContents } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as officeParser from 'officeparser';


const createWindow = () => {
  // Native-drawn window chrome per platform: macOS keeps its traffic lights
  // (titleBarStyle hidden), Windows renders native min/max/close on the right
  // via titleBarOverlay — colored to match the app background (#171717).
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 10 } }
      : isWindows
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: '#171717', symbolColor: '#d1d5db', height: 36 }
          }
        : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });

  mainWindow.setMenu(null);

  // Log renderer console messages to the terminal
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console]: ${message} (line ${line})`);
  });

  // Load the React app
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
  }
};

ipcMain.on('window-minimize', () => {
  BrowserWindow.getFocusedWindow()?.minimize();
});

ipcMain.on('window-maximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
});

ipcMain.on('window-close', () => {
  BrowserWindow.getFocusedWindow()?.close();
});

ipcMain.on('open-path', async (event, filePath) => {
  console.log('[open-path] Opening:', filePath);
  if (!filePath) {
    console.warn('[open-path] No filePath provided');
    return;
  }
  const err = await shell.openPath(filePath);
  if (err) {
    console.error('[open-path] Failed to open path:', err);
  }
});

ipcMain.handle('fetch-models', async (event, config) => {
  try {
    const { endpoint, apiKey } = config;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const url = endpoint.endsWith('/') ? `${endpoint}models` : `${endpoint}/models`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return { success: true, data };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// Unload a model from provider memory (Ollama native API).
ipcMain.handle('flush-model', async (event, config) => {
  try {
    const { baseUrl, model } = config;
    const url = baseUrl.endsWith('/') ? `${baseUrl}api/generate` : `${baseUrl}/api/generate`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
    await response.text();
    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
});

// Some providers reject unknown reasoning params (or don't support thinking on a given model).
// Retry once without them when the 400 error mentions reasoning/thinking.
const stripReasoningParams = (payload: any): any => {
  const { reasoning_effort, reasoning, enable_thinking, ...rest } = payload || {};
  return rest;
};

const shouldRetryWithoutReasoning = (status: number, errText: string): boolean =>
  status === 400 && /reasoning|thinking/i.test(errText);

ipcMain.handle('chat-complete', async (event, config) => {
  try {
    const { endpoint, apiKey, payload } = config;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    // OpenRouter requires HTTP referer headers usually, but it will work without them (as a fallback).
    headers['HTTP-Referer'] = 'http://localhost:5173';
    headers['X-Title'] = 'OneAgent';

    //debug: log payload structure (truncate base64 data)
    const debugPayload = JSON.parse(JSON.stringify(payload));
    if (debugPayload.messages) {
      for (const msg of debugPayload.messages) {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'image_url' && part.image_url?.url) {
              part.image_url.url = part.image_url.url.substring(0, 60) + '...[truncated]';
            }
          }
        }
      }
    }
    console.log('[chat-complete] Payload structure:', JSON.stringify(debugPayload, null, 2));

    const url = endpoint.endsWith('/') ? `${endpoint}chat/completions` : `${endpoint}/chat/completions`;
    let response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errText = await response.text();
      if (shouldRetryWithoutReasoning(response.status, errText)) {
        console.warn('[chat-complete] Provider rejected reasoning params, retrying without them');
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(stripReasoningParams(payload)),
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status} - ${await response.text()}`);
        }
      } else {
        throw new Error(`HTTP error! status: ${response.status} - ${errText}`);
      }
    }
    const data = await response.json();
    return { success: true, data };
  } catch (error: any) {
    console.error('[chat-complete] Fetch error:', error, error.cause);
    return { success: false, error: error.cause ? `${error.message} (Cause: ${error.cause.message || error.cause})` : error.message };
  }
});

// Active streaming abort controllers
const _streamAbortControllers = new Map<string, AbortController>();

ipcMain.handle('chat-stream', async (event, { endpoint, apiKey, payload, streamId }) => {
  const controller = new AbortController();
  if (streamId) {
    _streamAbortControllers.set(streamId, controller);
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    headers['HTTP-Referer'] = 'http://localhost:5173';
    headers['X-Title'] = 'OneAgent';

    const url = endpoint.endsWith('/') ? `${endpoint}chat/completions` : `${endpoint}/chat/completions`;
    const streamPayload = { ...payload, stream: true };

    let response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamPayload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      if (shouldRetryWithoutReasoning(response.status, errText)) {
        console.warn('[chat-stream] Provider rejected reasoning params, retrying without them');
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(stripReasoningParams(streamPayload)),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status} - ${await response.text()}`);
        }
      } else {
        throw new Error(`HTTP error! status: ${response.status} - ${errText}`);
      }
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let lastUsage: any = null;
    // Providers report why generation ended ('stop' | 'length' | ...) on the
    // final chunk. Needed so the renderer can detect silent max_tokens cutoffs.
    let lastFinishReason: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.replace(/^data:\s*/, '');
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          // Final chunk from most providers carries token usage for accounting.
          if (parsed.usage) lastUsage = parsed.usage;
          const choice = parsed.choices?.[0];
          if (choice) {
            if (choice.finish_reason) lastFinishReason = choice.finish_reason;
            const content = choice.delta?.content || '';
            const reasoning = choice.delta?.reasoning_content || choice.delta?.reasoning || choice.delta?.thinking || '';
            const toolCalls = choice.delta?.tool_calls;
            event.sender.send('chat-stream-delta', { streamId, content, reasoning, toolCalls });
          } else if (parsed.choices?.[0] === undefined && parsed.finish_reason) {
            lastFinishReason = parsed.finish_reason;
          }
        } catch {
          // Ignore incomplete chunk parse errors
        }
      }
    }

    event.sender.send('chat-stream-end', { streamId, usage: lastUsage, finishReason: lastFinishReason });
    return { success: true };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      event.sender.send('chat-stream-end', { streamId });
      return { success: true, aborted: true };
    }
    console.error('[chat-stream] Error:', error);
    const errorMessage = error.cause ? `${error.message} (Cause: ${error.cause.message || error.cause})` : error.message;
    event.sender.send('chat-stream-error', { streamId, error: errorMessage });
    return { success: false, error: errorMessage };
  } finally {
    if (streamId) {
      _streamAbortControllers.delete(streamId);
    }
  }
});

ipcMain.on('chat-stream-abort', (event, streamId) => {
  if (streamId && _streamAbortControllers.has(streamId)) {
    _streamAbortControllers.get(streamId)?.abort();
    _streamAbortControllers.delete(streamId);
  }
});

// Helper for document text sanitization
function sanitizeExtractedText(text: string, maxChars: number = 150000): string {
  if (!text) return '';
  let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  cleaned = cleaned.replace(/\r\n/g, '\n');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  if (cleaned.length > maxChars) {
    const total = cleaned.length;
    cleaned = cleaned.slice(0, maxChars) + `\n\n[... Document truncated: Showing first ${maxChars.toLocaleString()} of ${total.toLocaleString()} characters to fit model context ...]`;
  }
  return cleaned.trim();
}

function cleanHtmlText(html: string): string {
  if (!html) return '';
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n\n# $1\n\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n* $1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  return sanitizeExtractedText(
    text
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n')
  );
}

function parseMhtmlText(mhtml: string): string {
  if (!mhtml) return '';
  const boundaryMatch = mhtml.match(/boundary="?([^"\r\n]+)"?/i);
  if (!boundaryMatch) return cleanHtmlText(mhtml);
  const boundary = boundaryMatch[1];
  const parts = mhtml.split(new RegExp(`--${boundary}(?:--)?`, 'g'));

  for (const part of parts) {
    if (/Content-Type:\s*text\/html/i.test(part) || /Content-Type:\s*text\/plain/i.test(part)) {
      const isQuotedPrintable = /Content-Transfer-Encoding:\s*quoted-printable/i.test(part);
      const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(part);
      const isPlain = /Content-Type:\s*text\/plain/i.test(part);
      const bodyIndex = part.indexOf('\n\n') !== -1 ? part.indexOf('\n\n') : part.indexOf('\r\n\r\n');
      let body = bodyIndex !== -1 ? part.slice(bodyIndex) : part;

      if (isQuotedPrintable) {
        body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      } else if (isBase64) {
        try {
          body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
        } catch {}
      }
      return isPlain ? sanitizeExtractedText(body) : cleanHtmlText(body);
    }
  }
  return cleanHtmlText(mhtml);
}

ipcMain.handle('parse-document', async (event, { filePath, fileBuffer, fileName }) => {
  try {
    const { chunkText, parsePdfToChunks, parsePptxToChunks } = await import('./rag.js');
    const ext = (fileName || filePath || '').toLowerCase().split('.').pop() || '';
    const source = fileName || (filePath ? path.basename(filePath) : 'unknown');
    
    let buffer: Buffer | null = null;
    if (fileBuffer) {
      buffer = Buffer.from(fileBuffer);
    } else if (filePath && fs.existsSync(filePath)) {
      buffer = fs.readFileSync(filePath);
    }

    // 1. PDF
    if (ext === 'pdf' && buffer) {
      const chunks = await parsePdfToChunks(buffer, source);
      return { success: true, chunks, text: chunks.map((c: any) => c.text).join('\n\n') };
    }
    
    // 2. PPTX
    if (ext === 'pptx' && buffer) {
      const chunks = await parsePptxToChunks(buffer, source);
      return { success: true, chunks, text: chunks.map((c: any) => c.text).join('\n\n') };
    }

    // 3. Office & other formats
    if (['docx', 'xlsx', 'odt', 'odp', 'ods', 'rtf', 'epub'].includes(ext)) {
      try {
        let input: any = filePath;
        if ((!input || !fs.existsSync(input)) && buffer) {
          input = buffer;
        }
        if (input) {
          const parsed = await officeParser.parseOffice(input, {
            outputErrorToConsole: false,
            fileType: ext
          });
          const text = sanitizeExtractedText(typeof parsed.toText === 'function' ? parsed.toText() : String(parsed));
          return { success: true, chunks: chunkText(text, source), text };
        }
      } catch (err: any) {
        console.error('[parse-document] officeparser failed, fallback:', err);
      }
    }

    // 4. HTML
    if (['html', 'htm'].includes(ext)) {
      let rawHtml = buffer ? buffer.toString('utf-8') : '';
      const text = cleanHtmlText(rawHtml);
      return { success: true, chunks: chunkText(text, source), text };
    }

    // 5. MHTML
    if (['mhtml', 'mht'].includes(ext)) {
      let rawMhtml = buffer ? buffer.toString('utf-8') : '';
      const text = parseMhtmlText(rawMhtml);
      return { success: true, chunks: chunkText(text, source), text };
    }

    // 6. Standard text / code / CSV / JSON / Markdown
    let rawText = buffer ? buffer.toString('utf-8') : '';
    const text = sanitizeExtractedText(rawText);
    return { success: true, chunks: chunkText(text, source), text };
  } catch (err: any) {
    console.error('[parse-document] Error:', err);
    return { success: false, error: err.message || 'Failed to parse document' };
  }
});

ipcMain.handle('embed-texts', async (event, texts: string[]) => {
  try {
    const { embedTexts } = await import('./rag.js');
    const embeddings = await embedTexts(texts);
    return { success: true, embeddings };
  } catch (err: any) {
    console.error('[embed-texts] Error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('rag-search', async (event, { queryEmbedding, chunks, chunkEmbeddings, topK }) => {
  try {
    const { searchChunks } = await import('./rag.js');
    const topChunks = searchChunks(queryEmbedding, chunks, chunkEmbeddings, topK);
    return { success: true, topChunks };
  } catch (err: any) {
    console.error('[rag-search] Error:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-file-thumbnail', async (event, filePath) => {
  try {
    // Generates a thumbnail image from the file (like in Windows Explorer)
    const thumb = await nativeImage.createThumbnailFromPath(filePath, { width: 256, height: 256 });
    if (!thumb.isEmpty()) {
      return thumb.toDataURL();
    }
  } catch (e) {
    console.error('Failed to get thumbnail for', filePath, e);
  }
  
  // Fallback to getting the basic file icon if thumbnail is not available
  try {
    const icon = await app.getFileIcon(filePath, { size: 'normal' });
    if (!icon.isEmpty()) {
      return icon.toDataURL();
    }
  } catch (e2) {
    console.error('Failed to get file icon for', filePath, e2);
  }
  return null;
});

import { exec } from 'child_process';
import nutJs from '@nut-tree-fork/nut-js';
const { keyboard, mouse, Point, Button, Key } = nutJs;

// Maps friendly key names ("control", "enter", "arrowup") onto the provider's
// Key enum, falling back to case variants so single letters/keys just work.
const KEY_ALIASES: Record<string, string> = {
  control: 'LeftControl', ctrl: 'LeftControl',
  alt: 'LeftAlt', option: 'LeftAlt',
  shift: 'LeftShift',
  cmd: 'LeftCmd', command: 'LeftCmd', meta: 'LeftCmd',
  win: 'LeftWindows', super: 'LeftSuper',
  enter: 'Return', return: 'Return',
  esc: 'Escape', space: 'Space',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  pageup: 'PageUp', pagedown: 'PageDown'
};

const resolveNutKey = (name: string) => {
  const n = String(name).trim();
  const alias = KEY_ALIASES[n.toLowerCase()];
  const candidates = [alias, n, n.charAt(0).toUpperCase() + n.slice(1), n.toUpperCase()].filter(Boolean);
  for (const c of candidates) {
    const k = (Key as any)[c];
    if (k !== undefined) return k;
  }
  throw new Error(`Unknown key "${name}"`);
};

// --- AGENT DESKTOP TOOLS IPC HANDLERS ---
ipcMain.handle('take-screenshot', async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;
    const sources = await desktopCapturer.getSources({ 
      types: ['screen'], 
      thumbnailSize: { width, height } 
    });
    if (sources.length > 0) {
      return { success: true, image: sources[0].thumbnail.toDataURL() };
    }
    return { success: false, error: 'No screen found' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-click', async (event, opts) => {
  try {
    const btnName = String(opts.button || 'left').toLowerCase();
    const Btn = btnName === 'right' ? Button.RIGHT : btnName === 'middle' ? Button.MIDDLE : Button.LEFT;
    await mouse.setPosition(new Point(opts.x, opts.y));
    await new Promise(r => setTimeout(r, 60));
    if (opts.double) {
      await mouse.doubleClick(Btn);
    } else {
      await mouse.click(Btn);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-hotkey', async (event, { keys }) => {
  try {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { success: false, error: "desktop_hotkey requires a non-empty 'keys' array" };
    }
    await keyboard.pressKey(...keys.map(resolveNutKey));
    await keyboard.releaseKey(...keys.map(resolveNutKey));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-drag', async (event, { fromX, fromY, toX, toY }) => {
  try {
    await mouse.setPosition(new Point(fromX, fromY));
    await new Promise(r => setTimeout(r, 100));
    await mouse.pressButton(Button.LEFT);
    const steps = 15;
    for (let i = 1; i <= steps; i++) {
      await mouse.setPosition(new Point(
        Math.round(fromX + (toX - fromX) * i / steps),
        Math.round(fromY + (toY - fromY) * i / steps)
      ));
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 100));
    await mouse.releaseButton(Button.LEFT);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('desktop-type', async (event, { text }) => {
  try {
    await keyboard.type(text);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
ipcMain.handle('view-file', async (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('list-dir', async (event, dirPath) => {
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = items.map(item => ({
      name: item.name,
      isDir: item.isDirectory(),
      sizeBytes: item.isFile() ? fs.statSync(path.join(dirPath, item.name)).size.toString() : undefined
    }));
    return { success: true, items: result };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-to-file', async (event, options) => {
  try {
    const { targetFile, codeContent, overwrite } = options;
    if (fs.existsSync(targetFile) && !overwrite) {
      return { success: false, error: 'File already exists and overwrite is false' };
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, codeContent, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('replace-file-content', async (event, options) => {
  try {
    const { targetFile, targetContent, replacementContent } = options;
    let content = fs.readFileSync(targetFile, 'utf-8');
    if (!content.includes(targetContent)) {
      return { success: false, error: 'Target content not found in file' };
    }
    content = content.replace(targetContent, replacementContent);
    fs.writeFileSync(targetFile, content, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    fs.unlinkSync(filePath);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-send-input-event', async (event, { webContentsId, type, x, y, button, clickCount, modifiers, keyCode }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.sendInputEvent({ type, x, y, button, clickCount, modifiers, keyCode });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-insert-text', async (event, { webContentsId, text }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.insertText(text);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Captures only the agent browser webview page (used by browser_screenshot).
ipcMain.handle('browser-capture', async (event, webContentsId) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    let image;
    try {
      image = await wc.capturePage();
    } catch (captureErr: any) {
      // UnknownVizError occurs when the page is blank, not yet rendered, or GPU
      // cache is broken.  Retry once after a short delay; if that also fails,
      // return a 1×1 transparent placeholder so the agent can continue.
      if (captureErr?.message?.includes('UnknownVizError') || captureErr?.name === 'UnknownVizError') {
        await new Promise(r => setTimeout(r, 200));
        try {
          image = await wc.capturePage();
        } catch {
          const { nativeImage } = require('electron');
          image = nativeImage.createEmpty();
        }
      } else {
        throw captureErr;
      }
    }
    return { success: true, image: image.toDataURL() };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-emulate-device', async (event, webContentsId, options) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.enableDeviceEmulation(options);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('run-command', async (event, { command, cwd, timeoutMs }) => {
  return new Promise((resolve) => {
    exec(command, {
      cwd: cwd || process.cwd(),
      timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000,
      maxBuffer: 10 * 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({ success: !error, stdout, stderr, error: error?.message });
    });
  });
});

// Generic web search proxy: forwards { query, limit } to the user-configured
// endpoint with a Bearer token and passes the response back to the agent.
ipcMain.handle('search-web', async (event, { endpoint, apiKey, query, limit = 5 }) => {
  if (!endpoint || !endpoint.trim()) {
    return { success: false, error: 'No search endpoint configured' };
  }
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (apiKey && apiKey.trim()) {
      headers['Authorization'] = 'Bearer ' + apiKey.trim();
    }
    const response = await fetch(endpoint.trim(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, limit })
    });
    const text = await response.text();
    if (!response.ok) {
      return { success: false, error: `Search endpoint returned ${response.status}: ${text.substring(0, 500)}` };
    }
    return { success: true, results: text };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Recursive content search across a directory tree (the agent's `search_files`).
ipcMain.handle('grep-search', async (event, { query, path: rootDir, isRegex, maxResults }) => {
  try {
    if (!query || !String(query).trim()) return { success: false, error: 'Empty query' };
    const root = rootDir && String(rootDir).trim() ? path.resolve(String(rootDir)) : process.cwd();
    if (!fs.existsSync(root)) return { success: false, error: `Path not found: ${root}` };

    let rx: RegExp | null = null;
    let needle = '';
    if (isRegex) {
      try { rx = new RegExp(query, 'i'); } catch (e: any) { return { success: false, error: 'Invalid regex: ' + e.message }; }
    } else {
      needle = String(query).toLowerCase();
    }

    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'out', 'build', '.next', 'coverage', '__pycache__', '.venv']);
    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    const cap = Math.min(Math.max(Number(maxResults) || 200, 1), 1000);
    const matches: any[] = [];
    let filesScanned = 0;

    const walk = (dir: string, depth: number): void => {
      if (depth > 12 || matches.length >= cap || filesScanned > 8000) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (matches.length >= cap) return;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) walk(full, depth + 1);
          continue;
        }
        if (!ent.isFile()) continue;
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
        let content: string;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        if (content.includes('\u0000')) continue; // binary file
        filesScanned++;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const hit = rx ? rx.test(lines[i]) : lines[i].toLowerCase().includes(needle);
          if (hit) {
            matches.push({ file: full, lineNumber: i + 1, line: lines[i].slice(0, 300) });
            if (matches.length >= cap) return;
          }
        }
      }
    };

    walk(root, 0);
    return { success: true, matches, truncated: matches.length >= cap || undefined, scannedFiles: filesScanned };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Cookie inspection/management for the agent browser session.
ipcMain.handle('browser-cookies', async (event, { webContentsId, op = 'get', name, value, domain, url, expirationDate }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    const cookies = wc.session.cookies;

    if (op === 'get') {
      const filter: any = {};
      if (name) filter.name = name;
      if (domain) filter.domain = domain;
      const list = await cookies.get(filter);
      return {
        success: true,
        count: list.length,
        cookies: list.slice(0, 150).map(c => ({
          name: c.name,
          value: c.value.length > 120 ? c.value.slice(0, 120) + '…' : c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate
        }))
      };
    }

    if (op === 'set') {
      if (!name) return { success: false, error: "Cookie set requires 'name'" };
      const cookieUrl = url || (domain ? `https://${domain.replace(/^\./, '')}` : wc.getURL());
      await cookies.set({
        url: cookieUrl,
        name,
        value: value ?? '',
        domain: domain || undefined,
        expirationDate: expirationDate ? Number(expirationDate) : undefined,
        secure: cookieUrl.startsWith('https')
      });
      return { success: true, set: name };
    }

    if (op === 'delete') {
      if (!name) return { success: false, error: "Cookie delete requires 'name'" };
      const list = await cookies.get({ name });
      for (const c of list) {
        await cookies.remove(`http${c.secure ? 's' : ''}://${(c.domain || '').replace(/^\./, '')}${c.path}`, name);
      }
      return { success: true, removed: list.length };
    }

    if (op === 'clear') {
      const list = await cookies.get({});
      for (const c of list) {
        await cookies.remove(`http${c.secure ? 's' : ''}://${(c.domain || '').replace(/^\./, '')}${c.path}`, c.name);
      }
      return { success: true, removed: list.length };
    }

    return { success: false, error: `Unknown op "${op}"` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Navigation history of the embedded browser.
ipcMain.handle('browser-history', async (event, { webContentsId, op = 'list', index }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    const nav = (wc as any).navigationHistory;

    if (op === 'list') {
      const entries = nav.getAllEntries();
      const activeIndex = nav.getActiveIndex();
      return {
        success: true,
        activeIndex,
        entries: entries.map((e: any, i: number) => ({ index: i, url: e.url, title: e.title, active: i === activeIndex }))
      };
    }
    if (op === 'back') { wc.goBack(); return { success: true, moved: 'back' }; }
    if (op === 'forward') { wc.goForward(); return { success: true, moved: 'forward' }; }
    if (op === 'goto_index') {
      const idx = Number(index);
      if (!Number.isInteger(idx)) return { success: false, error: "goto_index requires numeric 'index'" };
      nav.restore?.(idx);
      return { success: true, movedToIndex: idx };
    }
    return { success: false, error: `Unknown op "${op}"` };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Native find-in-page with match counting and viewport highlight.
ipcMain.handle('find-in-page', async (event, { webContentsId, text, forward = true }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    if (!text) return { success: false, error: "find_in_page requires 'text'" };
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ success: false, error: 'find timed out' }), 4000);
      wc.once('found-in-page' as any, (_e: any, result: any) => {
        clearTimeout(timer);
        resolve({ success: true, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal });
      });
      wc.findInPage(text, { forward: forward !== false });
    });
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Downloads a URL through the agent browser session, waiting for completion.
ipcMain.handle('browser-download', async (event, { webContentsId, url, savePath }) => {
  try {
    const wc = webContents.fromId(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    if (!url) return { success: false, error: "browser_download requires 'url'" };

    return await new Promise((resolve) => {
      const session = wc.session;
      const timer = setTimeout(() => {
        cleanup();
        resolve({ success: false, error: 'Download timed out after 180s' });
      }, 180000);

      const handler = (_e: any, item: any) => {
        try {
          const targetPath = savePath || path.join(app.getPath('downloads'), item.getFilename());
          item.setSavePath(targetPath);
          item.once('done', (_e2: any, state: string) => {
            cleanup();
            resolve({
              success: state === 'completed',
              state,
              path: item.getSavePath(),
              filename: item.getFilename()
            });
          });
        } catch (err: any) {
          cleanup();
          resolve({ success: false, error: err.message });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        session.removeListener('will-download', handler);
      };

      session.on('will-download', handler);
      wc.downloadURL(url);
    });
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Reports which models are resident in local provider memory (VRAM / load
// state). Ollama exposes /api/ps; LM Studio has its v0 REST API. Cloud
// providers are metered by tokens — nothing to report.
ipcMain.handle('provider-status', async (event, { providers }) => {
  const status: Record<string, any> = {};

  await Promise.all((providers || []).map(async (p: any) => {
    try {
      if (p.id === 'ollama') {
        const base = p.endpoint.replace(/\/v1\/?$/, '');
        const res = await fetch(`${base}/api/ps`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        status[p.id] = {
          kind: 'vram',
          summary: `${data.models?.length || 0} model(s) in memory`,
          models: (data.models || []).map((m: any) => ({
            id: m.name,
            sizeBytes: m.size,
            vramBytes: m.size_vram,
            expiresAt: m.expires_at
          }))
        };
      } else if (p.id === 'lmstudio') {
        const base = p.endpoint.replace(/\/v1\/?$/, '');
        const res = await fetch(`${base}/api/v0/models`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const loaded = (data.data || []).filter((m: any) => m.state === 'loaded');
        status[p.id] = {
          kind: 'load-state',
          summary: `${loaded.length}/${data.data?.length || 0} model(s) loaded`,
          models: loaded.map((m: any) => ({ id: m.id, maxContextLength: m.max_context_length }))
        };
      } else {
        status[p.id] = { kind: 'cloud', summary: 'Token-metered API — no memory stats' };
      }
    } catch (err: any) {
      status[p.id] = { kind: 'unavailable', summary: `Status unavailable: ${err.message}` };
    }
  }));

  return { success: true, status };
});

app.on('web-contents-created', (event, contents) => {
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      contents.loadURL(url);
      return { action: 'deny' };
    });
    // Handle did-fail-load so Electron doesn't spam the console with
    // "Failed to load URL ... ERR_BLOCKED_BY_RESPONSE / ERR_TOO_MANY_REDIRECTS"
    // for every blocked tracker/ad subframe on ad-heavy pages.
    contents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 = ERR_ABORTED: navigation superseded, expected during rapid driving
      if (code === -3) return;
      console.warn(`[AgentBrowser] load failed (${code} ${desc}): ${url}`);
    });
  }
});

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
