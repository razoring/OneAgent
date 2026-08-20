import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as officeParser from 'officeparser';


const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
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
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${errText}`);
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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(streamPayload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`HTTP error! status: ${response.status} - ${errText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
          const choice = parsed.choices?.[0];
          if (choice) {
            const content = choice.delta?.content || '';
            const reasoning = choice.delta?.reasoning_content || choice.delta?.reasoning || choice.delta?.thinking || '';
            event.sender.send('chat-stream-delta', { streamId, content, reasoning });
          }
        } catch {
          // Ignore incomplete chunk parse errors
        }
      }
    }

    event.sender.send('chat-stream-end', { streamId });
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
    const thumb = await nativeImage.createThumbnailFromPath(filePath, { width: 64, height: 64 });
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
