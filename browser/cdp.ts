// Internal CDP client over Electron IPC (Node 30+ WebContentsView).
// Routes directly to the Main Process which holds the wc.debugger connection.

const api = () => (window as any).electronAPI;

export const cdpSend = async (wsUrl: string, targetId: string, method: string, params: any = {}): Promise<any> => {
  // We use targetId as the webContentsId directly in this architecture.
  const webContentsId = parseInt(targetId, 10);
  if (isNaN(webContentsId)) throw new Error('Invalid WebContents ID');

  const res = await api().cdpSend({ webContentsId, method, params });
  if (!res.success) throw new Error(res.error || `CDP ${method} failed`);
  return res.result;
};

// High-level helpers used by tool layer
export const cdpNavigate = async (port:number, targetId:string, wsUrl:string, url:string): Promise<void> => {
  await cdpSend(wsUrl, targetId, 'Page.enable', {});
  await cdpSend(wsUrl, targetId, 'Page.navigate', { url });
};

export const cdpCaptureScreenshot = async (port:number, targetId:string, wsUrl:string): Promise<string> => {
  await cdpSend(wsUrl, targetId, 'Page.enable', {}).catch(()=>{});
  const res: any = await cdpSend(wsUrl, targetId, 'Page.captureScreenshot', { format:'png', captureBeyondViewport:true });
  const data = res?.data;
  if (!data) throw new Error('Blank capture — CDP returned no data');
  return `data:image/png;base64,${data}`;
};

export const cdpEvaluate = async (port:number, targetId:string, wsUrl:string, expression:string, awaitPromise=true): Promise<any> => {
  await cdpSend(wsUrl, targetId, 'Runtime.enable', {}).catch(()=>{});
  const res: any = await cdpSend(wsUrl, targetId, 'Runtime.evaluate', { expression, awaitPromise, returnByValue:true });
  if (res?.exceptionDetails) throw new Error(res.exceptionDetails?.text || JSON.stringify(res.exceptionDetails));
  return res?.result?.value;
};

export const cdpDispatchMouse = async (port:number, targetId:string, wsUrl:string, type:'mousePressed'|'mouseReleased'|'mouseMoved'|'mouseWheel', x:number,y:number, opts:any={}): Promise<void> => {
  await cdpSend(wsUrl, targetId, 'Input.dispatchMouseEvent', { type, x, y, button: opts.button||'left', clickCount: opts.clickCount||1, modifiers: opts.modifiers||0, deltaX: opts.deltaX||0, deltaY: opts.deltaY||0, ...opts });
};

export const cdpDispatchKey = async (port:number, targetId:string, wsUrl:string, type:'keyDown'|'keyUp'|'char', key:string, opts:any={}): Promise<void> => {
  const params: any = { type, text: opts.text, key, ...opts };
  await cdpSend(wsUrl, targetId, 'Input.dispatchKeyEvent', params);
};

export const cdpInsertText = async (port:number, targetId:string, wsUrl:string, text:string): Promise<void> => {
  await cdpSend(wsUrl, targetId, 'Input.insertText', { text });
};

export const cdpGetCookies = async (port:number, targetId:string, wsUrl:string): Promise<any[]> => {
  const res: any = await cdpSend(wsUrl, targetId, 'Storage.getCookies', {});
  return res?.cookies || [];
};

export const genericCdpSend = cdpSend;

