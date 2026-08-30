import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface LaunchOpts {
  chromiumPath?: string;
  cdpPort?: number;
  launchArgs?: string;
  shortcutPath?: string;
}

const DEFAULT_PORT = 9222;
const CDP_HOST = '127.0.0.1';

const probeCdp = async (port: number, ms = 800): Promise<boolean> => {
  // Try both 127.0.0.1 and localhost, and both /json/version and /json/list
  const hosts = [CDP_HOST, 'localhost'];
  const paths = ['/json/version', '/json/list', '/json'];
  for (const host of hosts) {
    for (const p of paths) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), ms);
      try {
        const res = await fetch(`http://${host}:${port}${p}`, { signal: controller.signal } as any);
        if (res.ok) { clearTimeout(t); return true; }
      } catch {}
      finally { clearTimeout(t); }
    }
  }
  return false;
};

const isPortFree = async (port: number): Promise<boolean> => {
  try {
    const net: any = await import('net');
    return await new Promise<boolean>((res) => {
      const srv = net.createServer();
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(port, CDP_HOST);
    });
  } catch { return true; }
};

const getDevToolsActivePortPath = (binary: string): string | null => {
  const localAppData = process.env.LocalAppData || path.join(os.homedir(), 'AppData', 'Local');
  const base = path.basename(binary).toLowerCase();
  if (base.includes('msedge')) return path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'DevToolsActivePort');
  if (base.includes('brave')) return path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', 'DevToolsActivePort');
  if (base.includes('vivaldi')) return path.join(localAppData, 'Vivaldi', 'User Data', 'DevToolsActivePort');
  if (base.includes('opera')) return path.join(localAppData, 'Opera Software', 'Opera Stable', 'DevToolsActivePort');
  // Chrome/Chromium default
  return path.join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort');
};

const execFileAsync = (cmd: string, args: string[]): Promise<string> => new Promise((res) => {
  execFile(cmd, args, { timeout: 3000 }, (_e, stdout) => res(String(stdout || '').trim()));
});

const whereBinary = async (bin: string): Promise<string | null> => {
  if (process.platform === 'win32') {
    const out = await execFileAsync('where', [bin]);
    const first = out.split(/\r?\n/).map(s=>s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
    return null;
  }
  const out = await execFileAsync('which', [bin]);
  const line = out.split('\n')[0]?.trim();
  if (line && fs.existsSync(line)) return line;
  return null;
};

const regQuery = (key: string, value: string): Promise<string | null> => new Promise((res) => {
  if (process.platform !== 'win32') return res(null);
  execFile('reg', ['query', key, '/v', value], { timeout: 3000 }, (_e, stdout) => {
    const m = String(stdout).match(/REG_SZ\s+(.+)/);
    const v = m?.[1]?.trim();
    if (v && fs.existsSync(v)) res(v); else res(null);
  });
});

export const detectChromiumCandidates = async (): Promise<{path:string,label:string}[]> => {
  const out: {path:string,label:string}[] = [];
  const seen = new Set<string>();
  const push = (p:string|null,label:string) => {
    if (!p) return;
    const n = path.normalize(p).toLowerCase();
    if (seen.has(n)) return;
    if (!fs.existsSync(p)) return;
    seen.add(n);
    out.push({path:p,label});
  };
  if (process.platform === 'win32') {
    push(await regQuery('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',''), 'Chrome (HKLM)');
    push(await regQuery('HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',''), 'Chrome (HKCU)');
    push(await regQuery('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe',''), 'Edge');
    push(await regQuery('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe',''), 'Brave');
    for (const p of [
      path.join(process.env['ProgramFiles']||'C:\\Program Files','Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)','Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LocalAppData||'','Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['ProgramFiles']||'','Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['ProgramFiles(x86)']||'','Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.LocalAppData||'','BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(process.env['ProgramFiles']||'','BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(process.env.LocalAppData||'','Vivaldi\\Application\\vivaldi.exe'),
      path.join(process.env['ProgramFiles']||'','Vivaldi\\Application\\vivaldi.exe'),
    ]) push(p, path.basename(p));
    for (const b of ['chrome','chrome.exe','msedge','msedge.exe','brave','brave.exe','vivaldi','vivaldi.exe','opera','opera.exe']) {
      const w = await whereBinary(b);
      push(w, `via where:${b}`);
    }
  } else if (process.platform === 'darwin') {
    for (const p of [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Opera.app/Contents/MacOS/Opera',
      path.join(os.homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]) push(p, path.basename(path.dirname(p)));
    for (const b of ['google-chrome','chromium-browser','brave-browser','vivaldi','opera']) {
      const w = await whereBinary(b);
      push(w, `via which:${b}`);
    }
  } else {
    for (const b of ['google-chrome','google-chrome-stable','chromium','chromium-browser','brave-browser','vivaldi','opera','msedge']) {
      const w = await whereBinary(b);
      push(w, `via which:${b}`);
    }
    for (const p of ['/usr/bin/google-chrome','/usr/bin/chromium','/snap/bin/chromium']) push(p, path.basename(p));
  }
  return out;
};

export const detectChromiumPath = async (): Promise<string | null> => {
  const c = await detectChromiumCandidates();
  return c[0]?.path || null;
};

const parseLnkTarget = async (lnkPath: string): Promise<{target:string, args:string}|null> => {
  if (process.platform !== 'win32' || !lnkPath.toLowerCase().endsWith('.lnk')) return null;
  return new Promise((res) => {
    const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g,"''")}'); Write-Output $s.TargetPath; Write-Output $s.Arguments`;
    execFile('powershell.exe', ['-NoProfile','-Command',ps], { timeout: 4000 }, (_e, stdout) => {
      const lines = String(stdout).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
      if (lines.length >= 1 && lines[0]) res({target: lines[0], args: lines[1] || ''});
      else res(null);
    });
  });
};

const parseDesktopExec = (desktopPath: string): {target:string, args:string}|null => {
  try {
    const txt = fs.readFileSync(desktopPath,'utf8');
    const m = txt.match(/^\s*Exec\s*=\s*(.+)\s*$/m);
    if (!m) return null;
    const execLine = m[1].trim().replace(/%[a-zA-Z]/g,'').trim();
    const parts = execLine.split(/\s+/);
    const t = parts[0].replace(/^"|"$/g,'');
    const a = parts.slice(1).join(' ');
    return {target:t, args:a};
  } catch { return null; }
};

export const resolveLaunchTarget = async (opts: LaunchOpts): Promise<{binary:string, extraArgs:string}> => {
  let binary = (opts.chromiumPath || '').trim();
  let extraArgs = opts.launchArgs || '';
  let shortcutArgs = '';
  // If user pointed at a shortcut file, use its TargetPath
  if (binary && (binary.toLowerCase().endsWith('.lnk') || binary.toLowerCase().endsWith('.desktop') || binary.endsWith('.url'))) {
    const sp = binary;
    if (sp.toLowerCase().endsWith('.lnk')) {
      const parsed = await parseLnkTarget(sp);
      if (parsed) { binary = parsed.target; shortcutArgs = parsed.args; }
    } else if (sp.toLowerCase().endsWith('.desktop')) {
      const parsed = parseDesktopExec(sp);
      if (parsed) { binary = parsed.target; shortcutArgs = parsed.args; }
    } else if (sp.toLowerCase().endsWith('.url')) {
      try {
        const txt = fs.readFileSync(sp,'utf8');
        const mm = txt.match(/URL\s*=\s*(.+)/i);
        if (mm) {
          // .url points to a URL, not a binary — keep binary as detected, treat URL as initial page
          shortcutArgs += ` "${mm[1].trim()}"`;
        }
      } catch {}
      const auto = await detectChromiumPath();
      if (!binary || binary === sp) binary = auto || '';
    }
  }
  if (!binary) {
    const auto = await detectChromiumPath();
    if (auto) binary = auto;
  }
  // Merge shortcut args +用户 extraArgs (user extra after shortcut)
  if (shortcutArgs) extraArgs = `${shortcutArgs} ${extraArgs}`.trim();
  return {binary, extraArgs};
};

const isChromiumRunning = async (): Promise<boolean> => {
  try {
    if (process.platform === 'win32') {
      const out = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe']);
      if (/chrome\.exe/i.test(out)) return true;
      const out2 = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq msedge.exe']);
      if (/msedge\.exe/i.test(out2)) return true;
      const out3 = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq brave.exe']);
      if (/brave\.exe/i.test(out3)) return true;
    } else {
      const out = await execFileAsync('pgrep', ['-x', 'chrome']);
      if (out.trim()) return true;
      const out2 = await execFileAsync('pgrep', ['-x', 'msedge']);
      if (out2.trim()) return true;
    }
  } catch {}
  return false;
};

export const tryAlternativeBrowser = async (excludePath: string, port: number): Promise<{path:string,label:string}|null> => {
  const candidates = await detectChromiumCandidates();
  for (const c of candidates) {
    if (path.normalize(c.path).toLowerCase() === path.normalize(excludePath).toLowerCase()) continue;
    // Prefer a browser whose binary name differs (so different singleton)
    if (await probeCdp(port)) return null; // already listening, no need
    // Check if this candidate's browser is not running
    const bin = path.basename(c.path).toLowerCase();
    const running = await (async (): Promise<boolean> => {
      if (process.platform === 'win32') {
        const out = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${bin}`]);
        return new RegExp(bin.replace('.', '\\.'), 'i').test(out);
      } else {
        const out = await execFileAsync('pgrep', ['-x', bin.replace('.exe','')]);
        return !!out.trim();
      }
    })();
    if (!running) return c;
  }
  return null;
};

export const launchChromium = async (opts: LaunchOpts): Promise<{success:boolean, port:number, binary?:string, error?:string, listening?:boolean, alreadyRunning?:boolean, needsRestart?:boolean, alternative?:{path:string,label:string}}> => {
  const port = Number(opts.cdpPort) > 0 ? Number(opts.cdpPort) : DEFAULT_PORT;
  // Probe first — live profile may already be listening (user previously launched via Browser button)
  if (await probeCdp(port)) {
    return { success:true, port, listening:true, alreadyRunning:true };
  }
  const {binary, extraArgs} = await resolveLaunchTarget(opts);
  if (!binary || !fs.existsSync(binary)) {
    return { success:false, port, error:`Chromium binary not found: ${binary || '(auto-detect failed)'} — set it in Settings → Browser` };
  }
  // Check if requested port is already occupied by non-Chrome service
  if (!(await isPortFree(port))) {
    // Try next free port automatically (9223, 9224...)
    for (let p = port+1; p <= port+5; p++) {
      if (await isPortFree(p) && !(await probeCdp(p, 300))) {
        // Found free port — use it instead
        return launchChromium({ ...opts, cdpPort: p });
      }
    }
  }
  // Singleton check BEFORE spawn: if Chromium is already running without debugging, spawning will just reuse it and never listen
  const wasRunningBefore = await isChromiumRunning();
  if (wasRunningBefore) {
    // Don't spawn — it will just attach to existing non-debug instance. Tell user to close or use alternative.
    const alt = await tryAlternativeBrowser(binary, port);
    if (alt) {
      return {
        success:false, port, binary, needsRestart: true,
        alternative: alt,
        error:`${path.basename(binary)} is already running without debugging (singleton lock). Close all ${path.basename(binary)} windows and retry, or launch ${alt.label} (${path.basename(alt.path)}) instead — it uses a separate profile and can run in parallel on port ${port}.`
      };
    }
    return {
      success:false, port, binary, needsRestart: true,
      error:`${path.basename(binary)} is already running without --remote-debugging-port. Chromium's singleton lock shares the live profile — launching again just reuses the existing process. Close all Chromium windows (or click Force Relaunch) and retry. Live profile will be preserved.`
    };
  }
  const baseArgs = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    // Do NOT add --enable-automation / --enable-blink-features=AutomationControlled — avoids banner
  ];
  const extra = extraArgs ? extraArgs.split(/\s+/).filter(Boolean) : [];
  // Use live profile: do not pass --user-data-dir → shares human profile
  const args = [...baseArgs, ...extra];
  try {
    const child = spawn(binary, args, { detached:true, stdio:'ignore' });
    child.unref();
  } catch (e:any) {
    return { success:false, port, binary, error: e?.message || String(e) };
  }
  // Wait up to ~10s for CDP to listen (live profile cold start can be >6s due to extensions)
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await probeCdp(port, 600)) return { success:true, port, binary, listening:true, alreadyRunning:false };
    // Fallback: check DevToolsActivePort file for this specific browser (proves it started with debugging)
    try {
      const devToolsPortFile = getDevToolsActivePortPath(binary);
      if (devToolsPortFile && fs.existsSync(devToolsPortFile)) {
        const txt = fs.readFileSync(devToolsPortFile, 'utf8').trim().split(/\r?\n/)[0];
        if (Number(txt) === port) return { success:true, port, binary, listening:true, alreadyRunning:false };
      }
    } catch {}
    await new Promise(r=>setTimeout(r, 300));
  }
  // After spawn, still not listening — check if our spawned process is still running but failed (profile lock, port blocked)
  const stillRunning = await isChromiumRunning();
  if (stillRunning) {
    // Our spawn succeeded but didn't listen — likely port blocked or profile still locked from previous kill (SingletonLock not released)
    try {
      const localAppData = process.env.LocalAppData || '';
      const lockFile = path.join(localAppData, 'Google', 'Chrome', 'User Data', 'SingletonLock');
      if (lockFile && fs.existsSync(lockFile)) {
        try { fs.unlinkSync(lockFile); } catch {}
      }
    } catch {}
    // Fallback: try temp profile (isolated, no singleton lock) — guarantees debugging, though not live
    const tmpDir = path.join(os.tmpdir(), `oneagent-cdp-${port}-${Date.now()}`);
    try { fs.mkdirSync(tmpDir, { recursive:true }); } catch {}
    const tempArgs = [...baseArgs, `--user-data-dir=${tmpDir}`, ...extra];
    try {
      const child2 = spawn(binary, tempArgs, { detached:true, stdio:'ignore' });
      child2.unref();
      const deadline2 = Date.now() + 8000;
      while (Date.now() < deadline2) {
        if (await probeCdp(port, 600)) {
          return { success:true, port, binary, listening:true, alreadyRunning:false, error:`Launched with temporary profile at ${tmpDir} (live profile was locked). Close all Chromium and retry for live profile, or keep using temp.` } as any;
        }
        await new Promise(r=>setTimeout(r, 300));
      }
    } catch {}
    return { success:false, port, binary, needsRestart: true, error:`Launched ${path.basename(binary)} but CDP did not listen on ${port} within 10s. The new Chrome process is running but debugging not injected — port ${port} may be blocked, or the profile is still locked from the previous session. Try: 1) close all Chromium, wait 3s, retry, or 2) use Force Relaunch, or 3) pick a different port (9223) in Settings → Browser. Fallback temp profile also failed — check antivirus/firewall blocking ${port}.` };
  }
  return { success:false, port, binary, error:`Launched ${path.basename(binary)} but it exited immediately — check binary path and try a different Chromium. Port ${port} may be blocked.` };
};

export const killAndRelaunch = async (opts: LaunchOpts): Promise<{success:boolean, port:number, binary?:string, error?:string, listening?:boolean}> => {
  const port = Number(opts.cdpPort) > 0 ? Number(opts.cdpPort) : DEFAULT_PORT;
  // Kill all Chromium browsers (best effort)
  try {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/F','/IM','chrome.exe']);
      await execFileAsync('taskkill', ['/F','/IM','msedge.exe']);
      await execFileAsync('taskkill', ['/F','/IM','brave.exe']);
      await execFileAsync('taskkill', ['/F','/IM','vivaldi.exe']);
      await execFileAsync('taskkill', ['/F','/IM','opera.exe']);
      await new Promise(r=>setTimeout(r, 1200));
      // Clean stale SingletonLock / DevToolsActivePort that can survive taskkill
      try {
        const localAppData = process.env.LocalAppData || '';
        for (const sub of ['Google\\Chrome\\User Data', 'Microsoft\\Edge\\User Data', 'BraveSoftware\\Brave-Browser\\User Data']) {
          const base = path.join(localAppData, sub);
          for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']) {
            try { const fp = path.join(base, f); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
          }
        }
      } catch {}
      await new Promise(r=>setTimeout(r, 400));
    } else {
      await execFileAsync('pkill', ['-9', 'chrome']);
      await execFileAsync('pkill', ['-9', 'msedge']);
      await new Promise(r=>setTimeout(r, 1200));
    }
  } catch {}
  // Now relaunch — wasRunningBefore will be false, so we will actually spawn
  return launchChromium(opts);
};

export const chromeStatus = async (port = DEFAULT_PORT): Promise<{listening:boolean, port:number, version?:any}> => {
  try {
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 1200);
    const res = await fetch(`http://${CDP_HOST}:${port}/json/version`, { signal: controller.signal } as any);
    clearTimeout(t);
    if (!res.ok) return { listening:false, port };
    const j = await res.json().catch(()=>null);
    return { listening:true, port, version:j };
  } catch {
    return { listening:false, port };
  }
};

export const chromeListTargets = async (port = DEFAULT_PORT): Promise<any[]> => {
  const res = await fetch(`http://${CDP_HOST}:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP list failed ${res.status}`);
  return res.json();
};
