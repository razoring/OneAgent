import { app, BrowserWindow, ipcMain, nativeImage, shell, desktopCapturer, screen, webContents, dialog, protocol, net, WebContentsView } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import AdmZip from 'adm-zip';
import * as officeParser from 'officeparser';

// chat-asset:// must be registered as privileged before app ready so the
// renderer can load local images through it over both http (dev) and file (prod).
protocol.registerSchemesAsPrivileged([
  { scheme: 'chat-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);


let mainWindowRef: BrowserWindow | null = null;
const getMainWindow = (): BrowserWindow | null => mainWindowRef ?? BrowserWindow.getAllWindows()[0] ?? null;

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
      webviewTag: false,
    },
  });

  mainWindowRef = mainWindow;
  mainWindow.on('closed', () => { if (mainWindowRef === mainWindow) mainWindowRef = null; });
  mainWindow.setMenu(null);
  try { (mainWindow.webContents as any).setBackgroundThrottling?.(false); } catch {}
  // Re-attach any existing tabs (e.g. macOS activate after close) to the new
  // window offscreen — they were orphaned when the old window was destroyed.
  try {
    for (const [, tab] of managedTabs) {
      try { (mainWindow.contentView as any).addChildView(tab.view); } catch {}
      try { tab.view.setBounds(OFFSCREEN_BOUNDS as any); } catch {}
      try { (tab.view.webContents as any).setBackgroundThrottling?.(false); } catch {}
    }
  } catch {}

  // Log renderer console messages to the terminal (with origin file:line so
  // things like React's "Maximum update depth exceeded" are traceable).
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const file = sourceId ? sourceId.split('/').pop() : '?';
    console.log(`[Renderer Console]: ${message} (${file}:${line})`);
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
// ─── Agent workspace sandbox ─────────────────────────────────────────────────
// Sub-agent file tools resolve relative paths against a dedicated workspace
// folder — NOT the app's process CWD (which is the OneAgent source tree in
// dev, and leaked the whole repo to curious workers).
const workspaceRoot = () => {
  const dir = path.join(app.getPath('userData'), 'workspace');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
};
const resolveWorkspacePath = (p: string): string =>
  path.isAbsolute(p) ? p : path.join(workspaceRoot(), p);
ipcMain.handle('view-file', async (event, filePathIn) => {
  try {
    const content = fs.readFileSync(resolveWorkspacePath(filePathIn), 'utf-8');
    return { success: true, content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('list-dir', async (event, dirPathIn) => {
  try {
    const dirPath = resolveWorkspacePath(dirPathIn);
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
    const { codeContent, overwrite } = options;
    const targetFile = resolveWorkspacePath(options.targetFile);
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
    const { targetContent, replacementContent } = options;
    const targetFile = resolveWorkspacePath(options.targetFile);
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

ipcMain.handle('delete-file', async (event, filePathIn) => {
  try {
    fs.unlinkSync(resolveWorkspacePath(filePathIn));
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-send-input-event', async (event, { webContentsId: idIn, type, x, y, button, clickCount, modifiers, keyCode }) => {
  try {
    const wc = resolveTargetContents(idIn);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.sendInputEvent({ type, x, y, button, clickCount, modifiers, keyCode });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-insert-text', async (event, { webContentsId: idIn, text }) => {
  try {
    const wc = resolveTargetContents(idIn);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.insertText(text);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// Captures a tab's viewport — works for background/headless tabs simultaneously.
// All tabs stay attached to mainWindow.contentView. Background tabs are parked
// hidden at 0,0 with setVisible(false) (not offscreen-clipped at x=6000 which
// Chromium culls). For capture we temporarily promote parked tabs to visible
// at 0,0, capture, then re-hide — this gives true background rendering.
const captureLocks = new Map<string, Promise<void>>();
ipcMain.handle('browser-capture', async (event, webContentsId) => {
  let releaseLock: (() => void) | undefined;
  try {
    const wc = resolveTargetContents(webContentsId);
    if (!wc) return { success: false, error: 'WebContents not found' };
    let tab: ManagedTab | undefined;
    if (typeof webContentsId === 'string') tab = managedTabs.get(webContentsId);
    // Per-tab serialization for capture promotion — two simultaneous captures of
    // different parked tabs both promoting to 0,0 would otherwise flicker.
    const lockKey = typeof webContentsId === 'string' ? webContentsId : '__wc__'+String(webContentsId);
    const prevLock = captureLocks.get(lockKey) ?? Promise.resolve();
    let _release!: () => void;
    const curLock = new Promise<void>(r => { _release = r; });
    releaseLock = _release;
    captureLocks.set(lockKey, prevLock.then(() => curLock));
    await prevLock;

    let didPromote = false;
    let origBounds: any = null;
    try {
    if (tab) {
      try {
        ensureViewAttachedToMain(tab);
        (tab.view.webContents as any).setBackgroundThrottling?.(false);
        const b: any = tab.view.getBounds?.();
        // Detect parked state: setVisible(false) at 0,0 hidden — bounds valid but not visible
        // OFFSCREEN x>=5000 also counts as parked (legacy)
        const isParked = (b && b.x >= 5000) || (tab as any).isParked === true || ((): boolean => {
          try { return (tab!.view as any).getVisible ? !(tab!.view as any).getVisible() : false; } catch { return false; }
        })();
        // Also treat as parked if view is hidden via our flag or bounds don't match expected visible slot
        // For safety, if capture is for a tab that is not the currently visible one, promote.
        const shouldPromote = isParked || (b && b.width === 1280 && b.height === 800 && b.x === 0 && b.y === 0 && !(tab!.view as any).isVisible?.());
        // Simpler: if tab is not visible (parked), promote to 0,0 visible for capture
        let needsPromote = false;
        try {
          // WebContentsView.getVisible not always exists — fall back to isParked flag
          if (typeof (tab.view as any).getVisible === 'function') needsPromote = !(tab.view as any).getVisible();
          else needsPromote = !!(tab as any).isParked || (b && b.x === 0 && b.y === 0 && tab.bounds && (tab.bounds.x !== 0 || tab.bounds.y !== 0));
        } catch { needsPromote = !!(tab as any).isParked; }
        // Fallback: if we can't determine, promote if bounds looks like parked (0,0 with 1280x800 and tab is not the active visible one)
        if (!needsPromote && b && b.x === 0 && b.y === 0 && b.width === 1280 && b.height === 800) {
          // Check if there's a visible tab at slot — if this tab's logical bounds differ, it's parked
          if (tab.bounds && (tab.bounds.x !== 0 || tab.bounds.y !== 0)) needsPromote = true;
          else if ((tab as any).isParked) needsPromote = true;
        }
        if (needsPromote) {
          origBounds = b;
          didPromote = true;
          try { (tab.view as any).setVisible?.(true); } catch {}
          try { tab.view.setBounds({ x: 0, y: 0, width: VISIBLE_VIEWPORT.width, height: VISIBLE_VIEWPORT.height } as any); } catch {}
          try { (tab.view.webContents as any).setBackgroundThrottling?.(false); } catch {}
          // Give compositor a frame to paint at new visible rect
          await new Promise(r => setTimeout(r, 180));
        } else if (!b || b.width === 0 || b.height === 0) {
          const fallback = tab.bounds ?? VISIBLE_VIEWPORT;
          tab.view.setBounds({ x: 0, y: 0, width: fallback.width, height: fallback.height } as any);
          await new Promise(r => setTimeout(r, 120));
        }
      } catch {}
      // Wait briefly for navigation to settle if newly created
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        try {
          if (!tab.view.webContents.isLoading() && tab.ready) break;
        } catch {}
        await new Promise(r => setTimeout(r, 120));
      }
    }

    let image: Electron.NativeImage | undefined;
    // Retry loop: UnknownVizError / blank can occur if compositor hasn't painted yet
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        image = await wc.capturePage();
      } catch (captureErr: any) {
        if (captureErr?.message?.includes('UnknownVizError') || captureErr?.name === 'UnknownVizError') {
          await new Promise(r => setTimeout(r, 250 + attempt * 150));
          continue;
        }
        throw captureErr;
      }
      if (image && !image.isEmpty()) {
        const sz = image.getSize();
        if (sz.width > 0 && sz.height > 0) break;
      }
      // Blank frame — give compositor another tick
      await new Promise(r => setTimeout(r, 250));
    }
    if (!image || image.isEmpty()) image = nativeImage.createEmpty();
    const dataUrl = image.toDataURL();
    const sz = image.getSize();
    const pngBytes = sz.width * sz.height;
    if (!dataUrl || dataUrl === 'data:image/png;base64,' || dataUrl.length < 200 || pngBytes === 0) {
      // Final fallback: try to capture via offscreen rect explicitly
      try {
        const rect = tab ? (tab.view.getBounds?.() as any) : undefined;
        if (rect && rect.width > 0) {
          const alt = await wc.capturePage(rect as any).catch(() => null as any);
          if (alt && !alt.isEmpty() && alt.getSize().width > 0) return { success: true, image: alt.toDataURL() };
        }
      } catch {}
      return { success: false, error: 'Blank capture — the tab has not rendered anything yet' };
    }
    return { success: true, image: dataUrl };
    } finally {
      // Restore parked state and release per-tab capture lock
      if (didPromote && tab) {
        try { (tab.view as any).setVisible?.(false); } catch {}
        try { tab.view.setBounds(origBounds ?? ({ x: 0, y: 0, width: VISIBLE_VIEWPORT.width, height: VISIBLE_VIEWPORT.height } as any)); } catch {}
        try { (tab as any).isParked = true; } catch {}
      }
      try { releaseLock?.(); } catch {}
    }
  } catch (err: any) {
    try { releaseLock?.(); } catch {}
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browser-emulate-device', async (event, idIn, options) => {
  try {
    const wc = resolveTargetContents(idIn);
    if (!wc) return { success: false, error: 'WebContents not found' };
    wc.enableDeviceEmulation(options);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('run-command', async (event, { command, cwd: cwdIn, timeoutMs }) => {
  const cwd = cwdIn ? resolveWorkspacePath(cwdIn) : workspaceRoot();
  return new Promise((resolve) => {
    exec(command, {
      cwd,
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
ipcMain.handle('grep-search', async (event, { query, path: rootDirIn, isRegex, maxResults }) => {
  const rootDir = resolveWorkspacePath(rootDirIn);
  try {
    if (!query || !String(query).trim()) return { success: false, error: 'Empty query' };
    const root = rootDir;    if (!fs.existsSync(root)) return { success: false, error: `Path not found: ${root}` };

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
ipcMain.handle('browser-cookies', async (event, { webContentsId: idIn, op = 'get', name, value, domain, url, expirationDate }) => {
  try {
    const wc = resolveTargetContents(idIn);
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
ipcMain.handle('browser-history', async (event, { webContentsId: idIn, op = 'list', index }) => {
  try {
    const wc = resolveTargetContents(idIn);
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
ipcMain.handle('find-in-page', async (event, { webContentsId: idIn, text, forward = true }) => {
  try {
    const wc = resolveTargetContents(idIn);
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
ipcMain.handle('browser-download', async (event, { webContentsId: idIn, url, savePath }) => {
  try {
    const wc = resolveTargetContents(idIn);
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
        const [psRes, tagsRes] = await Promise.all([
          fetch(`${base}/api/ps`),
          fetch(`${base}/api/tags`).catch(() => null)
        ]);
        if (!psRes.ok) throw new Error(`HTTP ${psRes.status}`);
        const data = await psRes.json();
        // On-disk sizes for EVERY installed model — lets the renderer estimate
        // the VRAM cost of models that are not currently loaded.
        let available: any[] = [];
        if (tagsRes && tagsRes.ok) {
          try {
            const tags = await tagsRes.json();
            available = (tags.models || []).map((m: any) => ({ id: m.name, sizeBytes: m.size }));
          } catch { /* tags are best-effort */ }
        }
        status[p.id] = {
          kind: 'vram',
          summary: `${data.models?.length || 0} model(s) in memory`,
          models: (data.models || []).map((m: any) => ({
            id: m.name,
            sizeBytes: m.size,
            vramBytes: m.size_vram,
            expiresAt: m.expires_at
          })),
          available
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

// Total system VRAM usage across all GPUs (used/total bytes). Uses
// nvidia-smi when an NVIDIA driver is present; otherwise reports nothing.
ipcMain.handle('vram-usage', async () => {
  try {
    const { execFile } = await import('child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000 }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout));
      });
    });
    let usedBytes = 0, totalBytes = 0;
    for (const line of out.trim().split('\n')) {
      const [u, t] = line.split(',').map(s => parseInt(s.trim(), 10));
      if (!isNaN(u) && !isNaN(t)) { usedBytes += u * 1024 * 1024; totalBytes += t * 1024 * 1024; }
    }
    if (totalBytes > 0) return { success: true, usedBytes, totalBytes };
    return { success: false };
  } catch {
    return { success: false };
  }
});

// ─── Chat history persistence ────────────────────────────────────────────────
// Layout under <userData>/chats/:
//   index.json                    — metadata array (id, parentId, title, …)
//   <chatId>/messages.json        — { version, meta, messages }
//   <chatId>/assets/<hash>.<ext>  — images/screenshots extracted from data URLs
// Chats are flat records linked by parentId; deleting a parent cascades.

const chatsDir = () => path.join(app.getPath('userData'), 'chats');

const chatDirOf = (chatId: string) => {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(chatId)) throw new Error('Invalid chat id');
  return path.join(chatsDir(), chatId);
};

const assetsDirOf = (chatId: string) => path.join(chatDirOf(chatId), 'assets');
const messagesFileOf = (chatId: string) => path.join(chatDirOf(chatId), 'messages.json');
const indexFile = () => path.join(chatsDir(), 'index.json');

// Serialize all storage mutations so concurrent saves never interleave.
let storeQueue: Promise<any> = Promise.resolve();
const serialize = <T,>(fn: () => T | Promise<T>): Promise<T> => {
  const run = storeQueue.then(fn as any, fn as any) as Promise<T>;
  storeQueue = run.catch(() => {});
  return run;
};

const readJson = async (filePath: string): Promise<any> => {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const writeJsonAtomic = async (filePath: string, data: any) => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(data));
  await fs.promises.rename(tmp, filePath);
};

// Rebuild the index by scanning chat folders (missing/corrupt index fallback).
const rebuildIndex = async (): Promise<any[]> => {
  await fs.promises.mkdir(chatsDir(), { recursive: true });
  const entries = await fs.promises.readdir(chatsDir(), { withFileTypes: true });
  const metas: any[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = await readJson(messagesFileOf(e.name));
    if (file?.meta?.id === e.name) metas.push(file.meta);
  }
  await writeJsonAtomic(indexFile(), metas);
  return metas;
};

const loadIndex = async (): Promise<any[]> => {
  const idx = await readJson(indexFile());
  if (Array.isArray(idx)) return idx;
  return rebuildIndex();
};

const saveIndex = (metas: any[]) => writeJsonAtomic(indexFile(), metas);

// Recursively walk a message payload, extracting every inline data URL into
// an asset file. Returns a deep copy with `chat-asset://<chatId>/<file>` refs.
const DATA_URL_RE = /^data:([\w+.-]+\/[\w+.-]+)?(;base64)?,([\s\S]+)$/;
const extractAssets = async (value: any, chatId: string, depth = 0): Promise<any> => {
  if (depth > 12) return value;
  if (typeof value === 'string') {
    const m = DATA_URL_RE.exec(value);
    // Only hoist substantial binary payloads; tiny data URLs stay inline.
    if (!m || !m[2] || value.length < 4096) return value;
    const extMap: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
      'image/gif': 'gif', 'image/svg+xml': 'svg'
    };
    const mime = m[1] || 'application/octet-stream';
    const ext = extMap[mime] || 'bin';
    let buf: Buffer;
    try { buf = Buffer.from(m[3], 'base64'); } catch { return value; }
    if (buf.length === 0) return value;
    const name = `${crypto.createHash('sha1').update(buf).digest('hex')}.${ext}`;
    const filePath = path.join(assetsDirOf(chatId), name);
    try {
      await fs.promises.mkdir(assetsDirOf(chatId), { recursive: true });
      await fs.promises.writeFile(filePath, buf);
    } catch {
      return value; // keep the inline URL if the disk write fails
    }
    return `chat-asset://${chatId}/${name}`;
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = await extractAssets(value[i], chatId, depth + 1);
    return out;
  }
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const k of Object.keys(value)) out[k] = await extractAssets(value[k], chatId, depth + 1);
    return out;
  }
  return value;
};

// All descendant ids of a chat (not including itself).
const descendantIds = async (rootId: string): Promise<string[]> => {
  const idx = await loadIndex();
  const out: string[] = [];
  const walk = (parentId: string) => {
    for (const m of idx) {
      if (m.parentId === parentId && !out.includes(m.id)) {
        out.push(m.id);
        walk(m.id);
      }
    }
  };
  walk(rootId);
  return out;
};

const deleteChatTree = async (rootId: string): Promise<void> => {
  const ids = [rootId, ...(await descendantIds(rootId))];
  for (const id of ids) {
    await fs.promises.rm(chatDirOf(id), { recursive: true, force: true });
  }
  const idx = (await loadIndex()).filter((m: any) => !ids.includes(m.id));
  await saveIndex(idx);
};

ipcMain.handle('chats-list', async () => {
  try {
    return { success: true, chats: await serialize(loadIndex) };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e), chats: [] };
  }
});

ipcMain.handle('chats-load', async (_e, chatId: string) => {
  try {
    const file = await serialize(() => readJson(messagesFileOf(chatId)));
    if (!file) throw new Error('Chat not found');
    return { success: true, file };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-save', async (_e, chatId: string, payload: { meta?: any; messages?: any[] }) => {
  try {
    return {
      success: true,
      file: await serialize(async () => {
        // Refuse to resurrect a chat that was deleted while an agent was
        // still streaming into it.
        const idxBefore = await loadIndex();
        const known = idxBefore.some((m: any) => m.id === chatId);
        const existing = await readJson(messagesFileOf(chatId));
        if (!known && !existing) throw new Error('Chat no longer exists');
        const now = Date.now();
        const meta = {
          ...existing?.meta,
          ...(payload.meta || {}),
          id: chatId,
          updatedAt: now
        };
        const messages = await extractAssets(payload.messages ?? existing?.messages ?? [], chatId);
        const file = { version: 1 as const, meta, messages };
        await writeJsonAtomic(messagesFileOf(chatId), file);
        const idx = await loadIndex();
        const i = idx.findIndex((m: any) => m.id === chatId);
        if (i >= 0) idx[i] = meta; else idx.push(meta);
        await saveIndex(idx);
        return file;
      })
    };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-create', async (_e, spec: { parentId?: string | null; title?: string; agentId?: string }) => {
  try {
    const meta = await serialize(async () => {
      // Generate an id that is unique within the store.
      const gen = () => 'chat-' + crypto.randomBytes(6).toString('hex');
      let id = gen();
      while (fs.existsSync(chatDirOf(id))) id = gen();
      const now = Date.now();
      const m: any = {
        id,
        parentId: spec.parentId ?? null,
        title: spec.title || 'New Chat',
        createdAt: now,
        updatedAt: now,
        ...(spec.agentId ? { agentId: spec.agentId } : {})
      };
      await writeJsonAtomic(messagesFileOf(id), { version: 1, meta: m, messages: [] });
      const idx = await loadIndex();
      idx.push(m);
      await saveIndex(idx);
      return m;
    });
    return { success: true, meta };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-rename', async (_e, chatId: string, title: string) => {
  try {
    const clean = String(title || '').trim().slice(0, 120) || 'Untitled';
    const meta = await serialize(async () => {
      const idx = await loadIndex();
      const entry = idx.find((m: any) => m.id === chatId);
      if (!entry) throw new Error('Chat not found');
      entry.title = clean;
      entry.updatedAt = Date.now();
      await saveIndex(idx);
      return entry;
    });
    // Keep messages.json meta in sync (best effort).
    const file = await readJson(messagesFileOf(chatId));
    if (file) {
      file.meta = { ...file.meta, title: clean, updatedAt: meta.updatedAt };
      await writeJsonAtomic(messagesFileOf(chatId), file);
    }
    return { success: true, meta };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-delete', async (_e, chatId: string) => {
  try {
    await serialize(() => deleteChatTree(chatId));
    return { success: true };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

ipcMain.handle('chats-export-zip', async (event, chatId: string) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const idx = await loadIndex();
    const root = idx.find((m: any) => m.id === chatId);
    if (!root) throw new Error('Chat not found');

    // Logical tree layout in the zip: each chat becomes a folder named after
    // its title, nested chats nested under their parent's folder.
    const usedNames = new Set<string>();
    const folderName = (meta: any) => {
      const base = (meta.title || 'chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'chat';
      let name = base, n = 2;
      while (usedNames.has(name.toLowerCase())) name = `${base} (${n++})`;
      usedNames.add(name.toLowerCase());
      return name;
    };

    const zip = new AdmZip();
    const addChat = async (id: string, zipPath: string) => {
      const dir = chatDirOf(id);
      const file = await readJson(messagesFileOf(id));
      if (file) zip.addFile(path.posix.join(zipPath, 'messages.json'), Buffer.from(JSON.stringify(file, null, 2)));
      const assets = assetsDirOf(id);
      if (fs.existsSync(assets)) zip.addLocalFolder(assets, path.posix.join(zipPath, 'assets'));
      const childIds = idx.filter((m: any) => m.parentId === id).map((m: any) => m.id);
      for (const cid of childIds) {
        const childMeta = idx.find((m: any) => m.id === cid);
        await addChat(cid, path.posix.join(zipPath, folderName(childMeta)));
      }
    };
    await addChat(chatId, folderName(root));

    const safeTitle = (root.title || 'chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'chat';
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: 'Export chat',
      defaultPath: path.join(app.getPath('downloads'), `${safeTitle}.zip`),
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
    });
    if (canceled || !filePath) return { success: false, canceled: true };
    zip.writeZip(filePath);
    shell.showItemInFolder(filePath);
    return { success: true, path: filePath };
  } catch (e: any) {
    return { success: false, error: String(e?.message || e) };
  }
});

// Serve extracted chat assets to the renderer over chat-asset://<chatId>/<file>.
// Must be registered after app ready (protocol.handle touches defaultSession).
app.whenReady().then(() => {
  protocol.handle('chat-asset', (request) => {
    try {
      const url = new URL(request.url);
      const chatId = url.hostname;
      const fileName = decodeURIComponent(url.pathname.slice(1));
      if (!/^[A-Za-z0-9_-]{4,64}$/.test(chatId) || !/^[\w][\w.-]*$/.test(fileName)) {
        return new Response('Bad request', { status: 400 });
      }
      return net.fetch(pathToFileURL(path.join(assetsDirOf(chatId), fileName)).toString());
    } catch (e: any) {
      return new Response(`Not found: ${e?.message || e}`, { status: 404 });
    }
  });
});

// Electron logs every failed guest/webview navigation (ad trackers, blocked
// CSP frames, dead sync endpoints) through process.emitWarning. Financial and
// news sites fire dozens per page-load; drop exactly that category instead of
// flooding the terminal.
const origEmitWarning = process.emitWarning.bind(process);
(process as any).emitWarning = (warning: any, ...rest: any[]) => {
  try {
    const msg = typeof warning === 'string' ? warning : String(warning?.message ?? warning ?? '');
    if (msg.includes('Failed to load URL')) return;
  } catch {}
  return origEmitWarning(warning, ...rest);
};

// ─── WebContentsView tab manager (unified, embedded) ─────────────────────────
// Each tab is a WebContentsView attached to mainWindow.contentView. This
// fixes the white-viewport / z-index bug that existed when tabs were
// independent BrowserWindows (always behind mainWindow, wrong screen coords).
// Benefits vs old BrowserWindow approach:
//   • Correct Z (child view is INSIDE mainWindow, not behind it)
//   • Correct coords (contentView-relative = viewport-relative, no screen translation)
//   • True parallelism (each view has isolated session, cookies, storage)
//   • No taskbar / window leak, lighter than BrowserWindow
// All tabs stay ATTACHED (offscreen when not visible) so capturePage works
// for background agent tabs without requiring user to have rendered them.
// Visible tab is moved to the slot bounds; hidden tabs are parked at
// OFFSCREEN_BOUNDS but still painted and capturable simultaneously.

interface ManagedTab {
  id: string;
  view: WebContentsView;
  ready: boolean;
  url: string;
  title: string;
  loading: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  agentId?: string | null;
  isParked?: boolean;
}

const managedTabs = new Map<string, ManagedTab>();
let tabSeq = 0;
const genTabId = () => `btab-${Date.now().toString(36)}-${(tabSeq++).toString(36)}`;
const BROWSER_PARTITION_PREFIX = 'persist:oneagent_browser_';
const HOME_URL = 'https://html.duckduckgo.com/';
const DEFAULT_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };
const VISIBLE_VIEWPORT = { width: 1280, height: 800 };
// All tabs stay attached to mainWindow.contentView. Background tabs are parked
// hidden at 0,0 with setVisible(false) — not far offscreen (x=6000 is clipped
// by Chromium and stops painting). setVisible(false) keeps webContents alive
// with valid 1280x800 bounds but not composited; capturePage temporarily
// promotes to visible for a frame then re-hides. Never detach, never use a
// hidden BrowserWindow (show:false is occluded).
const OFFSCREEN_BOUNDS = { x: 6000, y: 0, width: 1280, height: 800 } as const;
const partitionForAgent = (agentId?: string | null) => `${BROWSER_PARTITION_PREFIX}${agentId || 'user'}`;

const forwardTabEvent = (tabId: string, patch: Record<string, unknown>) => {
  const win = getMainWindow();
  win?.webContents.send('browser-tab-event', { tabId, ...patch });
};

const ensureViewAttachedToMain = (tab: ManagedTab): boolean => {
  const win = getMainWindow();
  if (!win) return false;
  const cv: any = win.contentView;
  if (!cv.children.includes(tab.view)) {
    try { cv.addChildView(tab.view); } catch {}
  }
  try { (tab.view.webContents as any).setBackgroundThrottling?.(false); } catch {}
  return true;
};

const attachView = (tab: ManagedTab, bounds?: { x: number; y: number; width: number; height: number }) => {
  const b = bounds ?? tab.bounds ?? DEFAULT_BOUNDS;
  const win = getMainWindow();
  if (!win) {
    // Main not ready yet — queue attach; keep tab parked offscreen once window exists
    setTimeout(() => attachView(tab, b), 200);
    return;
  }
  ensureViewAttachedToMain(tab);
  try { (tab.view as any).setVisible?.(true); } catch {}
  try { (tab.view.webContents as any).setBackgroundThrottling?.(false); } catch {}
  if (b && b.width > 0 && b.height > 0) {
    tab.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } as any);
    tab.bounds = b;
  }
  tab.isParked = false;
};

const parkView = (tab: ManagedTab) => {
  // Keep attached to mainWindow but hidden — not offscreen clipped (x=6000 is
  // clipped by Chromium and stops painting). setVisible(false) keeps the
  // webContents alive with valid 1280x800 bounds at 0,0 but not composited,
  // so capturePage can still produce a frame (after temporary promote).
  const attached = ensureViewAttachedToMain(tab);
  if (!attached) return;
  try { (tab.view.webContents as any).setBackgroundThrottling?.(false); } catch {}
  try { (tab.view as any).setVisible?.(false); } catch {}
  try { tab.view.setBounds({ x: 0, y: 0, width: VISIBLE_VIEWPORT.width, height: VISIBLE_VIEWPORT.height } as any); } catch {}
  tab.isParked = true;
};

function createManagedTab(url: string, bounds?: { x: number; y: number; width: number; height: number }, agentId?: string): string {
  const id = genTabId();
  const part = partitionForAgent(agentId);
  const view = new WebContentsView({
    webPreferences: {
      partition: part,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  } as any);

  // All tabs start parked offscreen in mainWindow — capturable immediately
  // even when no container is visible. Never use a hidden window host (occluded).
  view.setBounds({ x: 0, y: 0, width: VISIBLE_VIEWPORT.width, height: VISIBLE_VIEWPORT.height } as any);
  try { (view as any).setVisible?.(false); } catch {}
  const tab: ManagedTab = { id, view, ready: false, url, title: 'New Tab', loading: true, bounds: bounds ?? DEFAULT_BOUNDS, agentId, isParked: true };
  managedTabs.set(id, tab);

  const wc = view.webContents as any;
  try { wc.setBackgroundThrottling(false); } catch {}
  // Attach immediately to mainWindow hidden for true headless operation
  const tryAttachMain = () => {
    const win = getMainWindow();
    if (win) {
      try { (win.contentView as any).addChildView(view); } catch {}
      try { view.setBounds({ x: 0, y: 0, width: VISIBLE_VIEWPORT.width, height: VISIBLE_VIEWPORT.height } as any); } catch {}
      try { (view as any).setVisible?.(false); } catch {}
      try { (view.webContents as any).setBackgroundThrottling?.(false); } catch {}
    } else {
      setTimeout(tryAttachMain, 200);
    }
  };
  tryAttachMain();

  wc.on('dom-ready', () => { tab.ready = true; tab.loading = false; forwardTabEvent(id, { ready: true, loading: false }); });
  wc.on('did-start-loading', () => { tab.loading = true; forwardTabEvent(id, { loading: true }); });
  wc.on('did-stop-loading', () => { tab.loading = false; forwardTabEvent(id, { loading: false }); });
  wc.on('did-navigate', (_e: any, navUrl: string) => { tab.url = navUrl; forwardTabEvent(id, { url: navUrl }); });
  wc.on('did-navigate-in-page', (_e: any, navUrl: string) => { tab.url = navUrl; forwardTabEvent(id, { url: navUrl }); });
  wc.on('page-title-updated', (_e: any, t: string) => { tab.title = t; forwardTabEvent(id, { title: t }); });
  wc.on('did-fail-load', (_e: any, code: number, desc: string, failedUrl: string, isMainFrame: boolean) => {
    if (!isMainFrame || code === -3) return;
    console.warn(`[Tabs] load failed (${code} ${desc}): ${failedUrl}`);
  });

  wc.setWindowOpenHandler((details: any) => {
    const openUrl: string = details?.url;
    if (openUrl && /^https?:/i.test(openUrl)) {
      const win = getMainWindow();
      win?.webContents.send('oneagent-browser-new-tab', openUrl);
    }
    return { action: 'deny' };
  });

  wc.loadURL(url).catch(() => {});
  return id;
}

const tabById = (id: string): ManagedTab | undefined => managedTabs.get(id);

const tabByAgentId = (agentId: string): ManagedTab | undefined => {
  for (const [, tab] of managedTabs) if (tab.agentId === agentId) return tab;
  return undefined;
};

ipcMain.handle('browser-tab-create', async (_e, options?: string | { url?: string; bounds?: any; agentId?: string }) => {
  if (typeof options === 'string' || options === undefined) return createManagedTab(options || HOME_URL);
  return createManagedTab(options.url || HOME_URL, options.bounds, options.agentId);
});

ipcMain.handle('browser-tab-close', async (_e, tabId: string) => {
  const t = tabById(tabId);
  if (!t) return { success: false };
  try { const win = getMainWindow(); if (win) try { (win.contentView as any).removeChildView(t.view); } catch {} } catch {}
  try { (t.view.webContents as any).close?.(); } catch {}
  try { (t.view.webContents as any).destroy?.(); } catch {}
  managedTabs.delete(tabId);
  return { success: true };
});

ipcMain.handle('browser-tab-activate', async (_e, payload: { id: string; bounds?: any }) => {
  const { id, bounds } = payload || ({} as any);
  const t = tabById(id);
  if (!t) return { success: false };
  if (bounds && bounds.width > 0 && bounds.height > 0) t.bounds = bounds;
  // Park all other tabs (hidden but still attached with valid size for capture)
  for (const [, other] of managedTabs) if (other.id !== id) parkView(other);
  attachView(t, bounds ?? t.bounds);
  // Ensure z-order: re-add active to bring to front
  try {
    const win = getMainWindow();
    if (win) {
      const cv: any = win.contentView;
      if (cv.children.includes(t.view)) {
        cv.removeChildView(t.view);
        cv.addChildView(t.view);
        // Restore visible after reorder
        if (typeof (t.view as any).setVisible === 'function') (t.view as any).setVisible(true);
        const b = bounds ?? t.bounds ?? DEFAULT_BOUNDS;
        t.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } as any);
      }
    }
  } catch {}
  return { success: true };
});

ipcMain.handle('browser-tab-hide', async (_e, tabId: string) => {
  const t = tabById(tabId);
  if (!t) return { success: false };
  parkView(t);
  return { success: true };
});

ipcMain.handle('browser-tab-hide-all', async () => {
  for (const [, t] of managedTabs) parkView(t);
  return { success: true };
});

ipcMain.handle('browser-tab-bounds', async (_e, payload: { id: string; bounds: any }) => {
  const t = tabById(payload?.id);
  if (!t) return { success: false };
  if (payload.bounds && payload.bounds.width > 0 && payload.bounds.height > 0) {
    t.bounds = payload.bounds;
    // Bounds updates come only from the visible (active) tab's RAF — move the
    // attached view to the slot. Offscreen parking is handled elsewhere via parkView.
    ensureViewAttachedToMain(t);
    try { if (typeof (t.view as any).setVisible === 'function') (t.view as any).setVisible(true); } catch {}
    try { t.view.setBounds({ x: Math.round(payload.bounds.x), y: Math.round(payload.bounds.y), width: Math.round(payload.bounds.width), height: Math.round(payload.bounds.height) } as any); } catch {}
  }
  return { success: true };
});

ipcMain.handle('browser-tab-call', async (_e, payload: { id: string; method: string; arg?: any }) => {
  const t = tabById(payload?.id);
  if (!t) return { success: false, error: 'No such tab' };
  const wc = t.view.webContents;
  try {
    switch (payload.method) {
      case 'loadURL': await wc.loadURL(String(payload.arg)).catch(() => {}); break;
      case 'goBack': if (wc.canGoBack()) wc.goBack(); break;
      case 'goForward': if (wc.canGoForward()) wc.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'stop': wc.stop(); break;
      default: return { success: false, error: `Unsupported method ${payload.method}` };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
});

ipcMain.handle('browser-tab-state', async (_e, tabId: string) => {
  const t = tabById(tabId);
  if (!t) return null;
  let loading = t.loading;
  try { loading = t.view.webContents.isLoading(); } catch {}
  return { id: t.id, url: t.url, title: t.title, ready: t.ready, loading };
});

ipcMain.handle('browser-tab-exec', async (_e, payload: { id: string; code: string }) => {
  const t = tabById(payload?.id);
  if (!t) throw new Error('No such tab');
  // Allow exec even before dom-ready for utility probes; dom-ready gate was too strict
  return await t.view.webContents.executeJavaScript(payload.code, false);
});

ipcMain.handle('browser-tab-get-by-agent', async (_e, agentId: string) => {
  const t = tabByAgentId(agentId);
  if (!t) return null;
  let loading = t.loading;
  try { loading = t.view.webContents.isLoading(); } catch {}
  return { id: t.id, url: t.url, title: t.title, ready: t.ready, loading };
});

ipcMain.handle('browser-tab-list', async () => {
  const tabs: any[] = [];
  for (const [id, t] of managedTabs) {
    let loading = t.loading;
    try { loading = t.view.webContents.isLoading(); } catch {}
    tabs.push({ id, url: t.url, title: t.title, ready: t.ready, loading, agentId: t.agentId });
  }
  return { success: true, tabs };
});

ipcMain.handle('browser-tab-show', async (_e, tabId: string) => {
  const t = tabById(tabId);
  if (!t) return { success: false };
  attachView(t);
  return { success: true };
});

ipcMain.handle('browser-tab-hide-window', async (_e, tabId: string) => {
  const t = tabById(tabId);
  if (!t) return { success: false };
  parkView(t);
  return { success: true };
});

// Explicit live-in-container handlers (headless + live)
ipcMain.handle('browser-tab-show-in-container', async (_e, payload: { id: string; bounds: any }) => {
  const t = tabById(payload?.id);
  if (!t) return { success: false, error: 'No such tab' };
  if (payload.bounds && payload.bounds.width > 0 && payload.bounds.height > 0) t.bounds = payload.bounds;
  for (const [, other] of managedTabs) if (other.id !== payload.id) parkView(other);
  attachView(t, payload.bounds ?? t.bounds);
  // bring to front
  try {
    const win = getMainWindow();
    if (win) {
      const cv: any = win.contentView;
      if (cv.children.includes(t.view)) {
        cv.removeChildView(t.view);
        cv.addChildView(t.view);
        if (typeof (t.view as any).setVisible === 'function') (t.view as any).setVisible(true);
        const b = payload.bounds ?? t.bounds ?? DEFAULT_BOUNDS;
        t.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } as any);
      }
    }
  } catch {}
  return { success: true };
});

ipcMain.handle('browser-tab-hide-in-container', async (_e, payload: { id: string }) => {
  const t = tabById(payload?.id);
  if (!t) return { success: false };
  parkView(t);
  return { success: true };
});

// Unified resolver for browser_* IPC that previously accepted numeric webContentsId
const resolveTargetContents = (id: number | string | undefined): Electron.WebContents | undefined => {
  if (typeof id === 'number') return webContents.fromId(id);
  if (typeof id === 'string') {
    const t = managedTabs.get(id);
    if (t) return t.view.webContents;
    const n = Number(id);
    if (!isNaN(n)) return webContents.fromId(n);
  }
  return undefined;
};
app.on('web-contents-created', (event, contents) => {
  if (contents.getType() === 'webview') {
    // New windows / target=_blank links become NEW TABS in the app's shared
    // browser shell instead of hijacking the same guest or popping an OS window.
    contents.setWindowOpenHandler(({ url }) => {
      if (url && /^https?:/i.test(url)) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('oneagent-browser-new-tab', url);
          break;
        }
      }
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
