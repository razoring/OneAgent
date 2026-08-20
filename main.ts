import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';


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
