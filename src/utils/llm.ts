import { sanitizeText, cleanHtml, parseMhtml, extractThinkingAndContent } from './docParser';

export interface LLMProvider {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  enabled: boolean;
}

export const DEFAULT_PROVIDERS: LLMProvider[] = [
  { id: 'ollama', name: 'Ollama', endpoint: 'http://localhost:11434/v1', apiKey: '', enabled: true },
  { id: 'lmstudio', name: 'LM Studio', endpoint: 'http://localhost:1234/v1', apiKey: '', enabled: true },
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', apiKey: '', enabled: false },
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', apiKey: '', enabled: false },
  { id: 'gemini', name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/', apiKey: '', enabled: false },
  { id: 'groq', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1', apiKey: '', enabled: false },
  { id: 'together', name: 'Together AI', endpoint: 'https://api.together.xyz/v1', apiKey: '', enabled: false },
];

export const getProviders = (): LLMProvider[] => {
  const stored = localStorage.getItem('llm_providers');
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as LLMProvider[];
      // Merge with default providers to ensure new defaults are added
      const merged = DEFAULT_PROVIDERS.map(defaultProvider => {
        const existing = parsed.find(p => p.id === defaultProvider.id);
        return existing ? existing : defaultProvider;
      });
      return merged;
    } catch (e) {
      console.error('Failed to parse providers', e);
    }
  }
  return DEFAULT_PROVIDERS;
};

export const saveProviders = (providers: LLMProvider[]) => {
  localStorage.setItem('llm_providers', JSON.stringify(providers));
  window.dispatchEvent(new Event('providers-updated'));
};

export interface ModelSettings {
  thinkingLevel: 'off' | 'low' | 'medium' | 'high';
  thinkingTimeout: number;
  temperature: number;
  topP: number;
  maxOutputLength: number;
  contextWindow: number;
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  thinkingLevel: 'medium',
  thinkingTimeout: 0,
  temperature: 0.7,
  topP: 0.95,
  maxOutputLength: 4096,
  contextWindow: 8192,
};

export const getModelSettings = (): ModelSettings => {
  const stored = localStorage.getItem('model_settings');
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      const cleaned = Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => v !== null && v !== undefined)
      );
      return { ...DEFAULT_MODEL_SETTINGS, ...cleaned } as ModelSettings;
    } catch (e) {
      console.error('Failed to parse model settings', e);
    }
  }
  return DEFAULT_MODEL_SETTINGS;
};

// Central settings write: persists and notifies every listener (ChatInput
// sliders, agent tools) so the whole app reflects the change instantly.
export const saveModelSettings = (settings: ModelSettings) => {
  localStorage.setItem('model_settings', JSON.stringify(settings));
  window.dispatchEvent(new Event('model-settings-updated'));
};

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

// Validates + applies a partial settings update coming from the agent's
// update_settings tool. Unknown keys are dropped; numbers are clamped to sane
// ranges. Returns the applied diff so the tool result can show what changed.
export const applySettingsUpdate = (partial: Record<string, any>): { applied: Partial<ModelSettings>, rejected: string[] } => {
  const current = getModelSettings();
  const applied: Partial<ModelSettings> = {};
  const rejected: string[] = [];

  const num = (key: keyof ModelSettings, min: number, max: number, int = false) => {
    const raw = partial[key];
    if (raw === undefined || raw === null) return;
    let v = Number(raw);
    if (!Number.isFinite(v)) {
      rejected.push(String(key));
      return;
    }
    if (int) v = Math.round(v);
    applied[key] = clamp(v, min, max) as never;
  };

  if (partial.thinkingLevel !== undefined) {
    const lvl = String(partial.thinkingLevel).toLowerCase();
    if (['off', 'low', 'medium', 'high'].includes(lvl)) applied.thinkingLevel = lvl as ModelSettings['thinkingLevel'];
    else rejected.push('thinkingLevel');
  }
  num('thinkingTimeout', 0, 600, true);
  num('temperature', 0, 2);
  num('topP', 0.01, 1);
  num('maxOutputLength', 256, 200000, true);
  num('contextWindow', 1024, 2097152, true);

  if (Object.keys(applied).length > 0) {
    saveModelSettings({ ...current, ...applied });
  }
  return { applied, rejected };
};

export interface WebSearchSettings {
  endpoint: string;
  apiKey: string;
}

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettings = {
  endpoint: '',
  apiKey: '',
};

export const getWebSearchSettings = (): WebSearchSettings => {
  const stored = localStorage.getItem('web_search_settings');
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<WebSearchSettings>;
      return {
        endpoint: parsed.endpoint || '',
        apiKey: parsed.apiKey || ''
      };
    } catch (e) {
      console.error('Failed to parse web search settings', e);
    }
  }
  return DEFAULT_WEB_SEARCH_SETTINGS;
};

export const saveWebSearchSettings = (settings: WebSearchSettings) => {
  localStorage.setItem('web_search_settings', JSON.stringify(settings));
  window.dispatchEvent(new Event('websearch-updated'));
};

// The search_web tool only exists when the user configured a provider.
export const isWebSearchConfigured = (): boolean => {
  const { endpoint } = getWebSearchSettings();
  return endpoint.trim().length > 0;
};

export interface BrowserSettings {
  chromiumPath: string;
  cdpPort: number;
  launchArgs: string;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  chromiumPath: '',
  cdpPort: 9222,
  launchArgs: '',
};

export const getBrowserSettings = (): BrowserSettings => {
  const stored = localStorage.getItem('browser_settings');
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<BrowserSettings>;
      return {
        chromiumPath: parsed.chromiumPath || '',
        cdpPort: Number(parsed.cdpPort) > 0 ? Number(parsed.cdpPort) : 9222,
        launchArgs: parsed.launchArgs || '',
      };
    } catch (e) {
      console.error('Failed to parse browser settings', e);
    }
  }
  return DEFAULT_BROWSER_SETTINGS;
};

export const saveBrowserSettings = (settings: BrowserSettings) => {
  localStorage.setItem('browser_settings', JSON.stringify(settings));
  window.dispatchEvent(new Event('browser-settings-updated'));
};

// Warm a model into provider memory with a minimal completion to improve TTFT.
export const primeModel = async (model: LLMModel): Promise<void> => {
  const provider = getProviders().find(p => p.id === model.provider);
  if (!provider) return;
  try {
    await (window as any).electronAPI.chatComplete({
      endpoint: provider.endpoint,
      apiKey: provider.apiKey,
      payload: {
        model: model.id,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
        temperature: 0,
      },
    });
  } catch {
    // priming is best-effort
  }
};

// Best-effort unload of a model from provider memory (Ollama only).
export const flushModel = async (model: LLMModel): Promise<void> => {
  if (model.provider !== 'ollama') return;
  const provider = getProviders().find(p => p.id === 'ollama');
  if (!provider) return;
  const baseUrl = provider.endpoint.replace(/\/v1\/?$/, '');
  try {
    await (window as any).electronAPI.flushModel({ baseUrl, model: model.id });
  } catch {
    // flushing is best-effort
  }
};

// --- Session token usage tracking -------------------------------------------
// Accumulated per provider/model as responses come back so the agent can query
// its own consumption via get_model_stats and make informed switching decisions.
export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

const usageByModel = new Map<string, UsageRecord>();

export const recordUsage = (
  providerId: string,
  modelId: string,
  usage?: { prompt_tokens?: number | string, completion_tokens?: number | string } | null
): void => {
  if (!usage) return;
  const p = Number(usage.prompt_tokens || 0);
  const c = Number(usage.completion_tokens || 0);
  if (!p && !c) return;
  const key = `${providerId}/${modelId}`;
  const rec = usageByModel.get(key) || { promptTokens: 0, completionTokens: 0, calls: 0 };
  rec.promptTokens += p;
  rec.completionTokens += c;
  rec.calls += 1;
  usageByModel.set(key, rec);
};

export const getSessionUsage = () => {
  const byModel: Record<string, UsageRecord> = {};
  let totalPrompt = 0;
  let totalCompletion = 0;
  usageByModel.forEach((v, k) => {
    byModel[k] = { ...v };
    totalPrompt += v.promptTokens;
    totalCompletion += v.completionTokens;
  });
  return {
    totals: { promptTokens: totalPrompt, completionTokens: totalCompletion },
    byModel
  };
};

// Cloud providers only include `usage` in streamed responses when explicitly
// requested. Local servers (Ollama/LM Studio) send it natively in the final chunk.
const PROVIDERS_NEEDING_USAGE_FLAG = new Set(['openai', 'openrouter', 'groq', 'together', 'gemini']);

// Asks the main process which models are currently resident in provider memory
// (VRAM for Ollama via /api/ps, load state for LM Studio). Cloud providers report
// nothing — they are metered by tokens, not memory.
export const getProviderStatus = async (): Promise<Record<string, any>> => {
  try {
    const providers = getProviders().filter(p => p.enabled);
    const api = (window as any).electronAPI;
    if (!api?.providerStatus) return {};
    const res = await api.providerStatus({ providers });
    return res?.success ? (res.status || {}) : {};
  } catch {
    return {};
  }
};

// Combined self-stats snapshot consumed by the get_model_stats tool.
export const getModelStats = async (activeModel?: LLMModel | null) => {
  const [loaded] = await Promise.all([getProviderStatus()]);
  return {
    activeModel: activeModel ? { id: activeModel.id, provider: activeModel.provider } : null,
    settings: getModelSettings(),
    tokenUsage: getSessionUsage(),
    loadedModels: loaded
  };
};

// Provider-specific reasoning/thinking parameters.
// 'off' must send an explicit disable signal — several providers (e.g. Ollama)
// enable thinking by default when no reasoning parameter is present.
export const applyThinkingParams = (payload: any, providerId: string, level?: string): void => {
  const isOff = !level || level === 'off';
  switch (providerId) {
    case 'openrouter':
      payload.reasoning = isOff ? { enabled: false } : { effort: level };
      break;
    case 'together':
      if (isOff) payload.enable_thinking = false;
      break;
    case 'lmstudio':
      // LM Studio ignores reasoning_effort on /v1/chat/completions; sending it can cause errors
      break;
    default:
      // Ollama, OpenAI, Gemini, Groq and other OpenAI-compatible servers
      payload.reasoning_effort = isOff ? 'none' : level;
      break;
  }
};

export interface LLMModel {
  id: string;
  name: string;
  provider: string; // provider ID
}

export const fetchModels = async (): Promise<LLMModel[]> => {
  const providers = getProviders().filter(p => p.enabled);
  let allModels: LLMModel[] = [];

  for (const p of providers) {
    try {
      const response = await (window as any).electronAPI.fetchModels({
        endpoint: p.endpoint,
        apiKey: p.apiKey
      });
      if (response.success && response.data && response.data.data) {
        const models = response.data.data.map((m: any) => ({
          id: m.id,
          name: m.id, // Some APIs provide a name field, some just have id
          provider: p.id,
        }));
        allModels = [...allModels, ...models];
      }
    } catch (e) {
      console.error(`Error fetching models for ${p.name}:`, e);
    }
  }

  return allModels;
};

//convert local file to base64 for vision models, with downscaling and conversion to JPEG
export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const ext = file.name.toLowerCase().split('.').pop() || '';
    // SVG is best left as raw SVG text or data URI
    if (ext === 'svg' || file.type === 'image/svg+xml') {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = error => reject(error);
      return;
    }

    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const rawResult = reader.result as string;

      // Use Canvas to normalize any image (AVIF, PNG, WEBP, BMP, JPEG) into standard JPEG
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const MAX_DIM = 1024;
        
        if (width > MAX_DIM || height > MAX_DIM) {
          const ratio = Math.min(MAX_DIM / width, MAX_DIM / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          // Fallback if canvas fails
          const base64Data = rawResult.includes(',') ? rawResult.split(',')[1] : rawResult;
          resolve(`data:image/jpeg;base64,${base64Data}`);
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        // Standardize on image/jpeg for all Vision LLMs (Ollama, OpenAI, Gemini)
        const compressedUri = canvas.toDataURL('image/jpeg', 0.85);
        console.log(`[fileToBase64] Converted & downscaled ${file.name} to ${width}x${height} JPEG`);
        resolve(compressedUri);
      };
      img.onerror = () => {
        // Fallback if image fails to render in canvas
        const base64Data = rawResult.includes(',') ? rawResult.split(',')[1] : rawResult;
        resolve(`data:image/jpeg;base64,${base64Data}`);
      };
      img.src = rawResult;
    };
    reader.onerror = error => reject(error);
  });
};

// Downscale an existing base64 data-url image (e.g. tool screenshots) so vision
// payloads stay small. Resolves with the original if decoding/canvas fails.
export const downscaleDataUrl = (dataUrl: string, maxDim = 1280, quality = 0.85): Promise<string> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const ratio = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });

export interface DocumentChunk {
  text: string;
  metadata: {
    source: string;
    page?: number;
    slide?: number;
    chunkIndex: number;
  };
}

export interface ParsedDocument {
  text: string;
  chunks?: DocumentChunk[];
  chunkEmbeddings?: number[][];
}

// Robust document parser that extracts clean text from Office, PDF, HTML, MHTML, and code files
export const parseAttachmentDocument = async (file: File): Promise<ParsedDocument> => {
  const ext = file.name.toLowerCase().split('.').pop() || '';
  let filePath = '';
  if ((window as any).electronAPI?.getPathForFile) {
    filePath = (window as any).electronAPI.getPathForFile(file);
  } else {
    filePath = (file as any).path || '';
  }

  // Try backend extraction via Electron IPC first (for PDF, DOCX, PPTX, XLSX, HTML, MHTML, etc.)
  if ((window as any).electronAPI?.parseDocument) {
    try {
      let fileBuffer: ArrayBuffer | undefined;
      if (!filePath) {
        fileBuffer = await file.arrayBuffer();
      }
      const res = await (window as any).electronAPI.parseDocument({
        filePath: filePath || undefined,
        fileBuffer: fileBuffer ? Array.from(new Uint8Array(fileBuffer)) : undefined,
        fileName: file.name
      });
      if (res.success && typeof res.text === 'string') {
        let chunkEmbeddings;
        if (res.chunks && res.chunks.length > 0 && (window as any).electronAPI.embedTexts) {
          try {
            const embedRes = await (window as any).electronAPI.embedTexts(res.chunks.map((c: any) => c.text));
            if (embedRes.success) {
              chunkEmbeddings = embedRes.embeddings;
            }
          } catch (embedError) {
            console.error('[parseAttachmentDocument] Failed to generate embeddings for chunks:', embedError);
          }
        }
        return { text: res.text, chunks: res.chunks, chunkEmbeddings };
      }
    } catch (e) {
      console.error('[parseAttachmentDocument] IPC extraction failed, falling back:', e);
    }
  }

  // Client-side fallback for text / HTML / MHTML
  try {
    const raw = await file.text();
    let text = raw;
    if (ext === 'html' || ext === 'htm') {
      text = cleanHtml(raw);
    } else if (ext === 'mhtml' || ext === 'mht') {
      text = parseMhtml(raw);
    } else {
      text = sanitizeText(raw);
    }
    return { text };
  } catch (e) {
    console.error('[parseAttachmentDocument] Text extraction failed:', e);
    return { text: `[Unable to extract text from ${file.name}]` };
  }
};

export interface StreamUpdate {
  content: string;
  thinking: string;
  isGenerating: boolean;
  toolCalls?: string[];
  isCallingTool?: boolean;
}

export interface ChatStreamResult {
  content: string;
  thinking: string;
  toolCalls?: string[];
  isCallingTool?: boolean;
  // Provider finish reason ('stop' | 'length' | ...) — 'length' means the
  // output was cut off by max_tokens before the model finished its turn.
  finishReason?: string | null;
}

// When prior assistant thinking is re-injected into context, compress it
// intelligently instead of replaying full prose. Keeps lines that carry
// decisions/actions (wherever they appear in the block) plus the most recent
// line, drops pure narration. Models imitate the thinking style they see,
// so shorter history = faster thinking.
const THINKING_INJECTION_LIMIT = 700;

// Tool names, arrows, element ids, action verbs — the signature of a
// decision line vs descriptive prose.
const DECISION_LINE =
  /((browser|desktop|view|list|search|write_to|replace_file|run_command|delete|spawn|switch|get|update)_\w+|→|->|\b(?:id|ids)\s*[:#=]?\s*\d|\b(click|scroll|navigate|typed?|submit|select|observe|download|wait)\b)/i;

export const condenseThinking = (thinking: string | undefined | null, maxChars = THINKING_INJECTION_LIMIT): string => {
  const t = (thinking || '').trim();
  if (!t || t.length <= maxChars) return t;
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);

  // Walk newest → oldest; keep the latest line unconditionally (current
  // state), other lines only when they look like decisions.
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0 && used < maxChars; i--) {
    const isLatest = i === lines.length - 1;
    if (!isLatest && !DECISION_LINE.test(lines[i])) continue;
    const cost = lines[i].length + 1;
    if (kept.length > 0 && used + cost > maxChars) break;
    kept.unshift(lines[i]);
    used += cost;
  }

  if (kept.length === 0) {
    // Single oversized blob with nothing recognizable: fall back to tail slice.
    const tail = t.slice(-maxChars).replace(/^\S*\s+/, '');
    return `[Earlier reasoning condensed]\n…${tail}`;
  }
  return `[Earlier reasoning condensed to decision lines — ${t.length - used} chars omitted]\n${kept.join('\n')}`;
};

// Generates a streaming chat completion, feeding thinking and response deltas in real-time
export const generateChatStream = async (
  model: LLMModel,
  messages: any[],
  onUpdate: (update: StreamUpdate) => void,
  signal?: AbortSignal,
  settings?: ModelSettings,
  tools?: any[]
): Promise<ChatStreamResult> => {
  const providers = getProviders();
  const provider = providers.find(p => p.id === model.provider);
  if (!provider) throw new Error('Provider not found');

  const modelSettings = settings || getModelSettings();
  const streamId = Math.random().toString(36).substring(7);
  let accumulatedContent = '';
  let accumulatedReasoning = '';

  let accumulatedToolCalls: any[] = [];

  const processAndEmit = () => {
    // Extract thinking tags if present in standard content
    const parsed = extractThinkingAndContent(accumulatedContent);
    const combinedThinking = [accumulatedReasoning, parsed.thinking].filter(Boolean).join('\n\n').trim();
    const finalContent = parsed.content;

    // Convert accumulated native tool calls to strings for backward compatibility with ChatArea
    const nativeToolCalls = accumulatedToolCalls.filter(Boolean).map(tc => {
      let parsedArgs = tc.function.arguments;
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        // Leave as string if it's incomplete
      }
      return JSON.stringify({
        name: tc.function.name,
        arguments: parsedArgs
      });
    });

    onUpdate({
      content: finalContent,
      thinking: combinedThinking,
      isGenerating: true,
      toolCalls: nativeToolCalls.length > 0 ? nativeToolCalls : parsed.toolCalls,
      isCallingTool: nativeToolCalls.length > 0 || parsed.isCallingTool
    });
  };

  if ((window as any).electronAPI?.chatStream) {
    return new Promise((resolve, reject) => {
      let cleanupDelta: (() => void) | undefined;
      let cleanupEnd: (() => void) | undefined;
      let cleanupError: (() => void) | undefined;
      let timeoutTimer: any = null;

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (cleanupDelta) cleanupDelta();
        if (cleanupEnd) cleanupEnd();
        if (cleanupError) cleanupError();
      };

      if (modelSettings.thinkingTimeout > 0) {
        timeoutTimer = setTimeout(() => {
          (window as any).electronAPI?.abortChatStream(streamId);
          cleanup();
          const parsed = extractThinkingAndContent(accumulatedContent);
          const combinedThinking = [accumulatedReasoning, parsed.thinking, `[Thinking timeout (${modelSettings.thinkingTimeout}s) reached]`].filter(Boolean).join('\n\n').trim();
          onUpdate({
            content: parsed.content,
            thinking: combinedThinking,
            isGenerating: false,
            toolCalls: parsed.toolCalls,
            isCallingTool: parsed.isCallingTool
          });
          resolve({ content: parsed.content, thinking: combinedThinking, toolCalls: parsed.toolCalls, isCallingTool: parsed.isCallingTool });
        }, modelSettings.thinkingTimeout * 1000);
      }

      if (signal) {
        signal.addEventListener('abort', () => {
          (window as any).electronAPI.abortChatStream(streamId);
          cleanup();
          const parsed = extractThinkingAndContent(accumulatedContent);
          resolve({
            content: parsed.content,
            thinking: [accumulatedReasoning, parsed.thinking].filter(Boolean).join('\n\n').trim()
          });
        });
      }

      cleanupDelta = (window as any).electronAPI.onStreamDelta((data: any) => {
        if (data.streamId !== streamId) return;
        if (data.reasoning) {
          accumulatedReasoning += data.reasoning;
        }
        if (data.content) {
          accumulatedContent += data.content;
          
          // Detect and abort on known model hallucination loops (e.g. Gemma4 <|channel> loops)
          if (accumulatedContent.endsWith('<|channel>thought<|channel>thought<|channel>thought')) {
            (window as any).electronAPI?.abortChatStream(streamId);
            accumulatedContent = accumulatedContent.replace(/(<\|channel>thought)+$/, '\\n\\n[Generation aborted: Model hallucination loop detected. Try a different approach or tool.]');
            cleanup();
            const parsed = extractThinkingAndContent(accumulatedContent);
            const combinedThinking = [accumulatedReasoning, parsed.thinking].filter(Boolean).join('\\n\\n').trim();
            onUpdate({
              content: parsed.content,
              thinking: combinedThinking,
              isGenerating: false,
              toolCalls: parsed.toolCalls,
              isCallingTool: parsed.isCallingTool
            });
            resolve({ content: parsed.content, thinking: combinedThinking, toolCalls: parsed.toolCalls, isCallingTool: parsed.isCallingTool });
            return;
          }
        }
        if (data.toolCalls) {
          data.toolCalls.forEach((tc: any) => {
            const idx = tc.index;
            if (!accumulatedToolCalls[idx]) {
              accumulatedToolCalls[idx] = { id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '' } };
            } else {
              if (tc.function?.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
              if (tc.function?.name) accumulatedToolCalls[idx].function.name += tc.function.name;
            }
          });
        }
        processAndEmit();
      });

      cleanupEnd = (window as any).electronAPI.onStreamEnd((data: any) => {
        if (data.streamId !== streamId) return;
        cleanup();
        recordUsage(provider.id, model.id, data.usage);
        const parsed = extractThinkingAndContent(accumulatedContent);
        const combinedThinking = [accumulatedReasoning, parsed.thinking].filter(Boolean).join('\n\n').trim();
        
        const nativeToolCalls = accumulatedToolCalls.filter(Boolean).map(tc => {
          let parsedArgs = tc.function.arguments;
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            // Leave as string
          }
          return JSON.stringify({
            name: tc.function.name,
            arguments: parsedArgs
          });
        });

        const finalToolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : parsed.toolCalls;
        const isCallingTool = nativeToolCalls.length > 0 || parsed.isCallingTool;

        onUpdate({
          content: parsed.content,
          thinking: combinedThinking,
          isGenerating: false,
          toolCalls: finalToolCalls,
          isCallingTool: isCallingTool
        });
        resolve({ content: parsed.content, thinking: combinedThinking, toolCalls: finalToolCalls, isCallingTool: isCallingTool, finishReason: (data as any).finishReason ?? null });
      });

      cleanupError = (window as any).electronAPI.onStreamError((data: any) => {
        if (data.streamId !== streamId) return;
        cleanup();
        reject(new Error(data.error || 'Streaming error occurred'));
      });

      const payload: any = {
        model: model.id,
        messages,
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
      }

      if (typeof modelSettings.temperature === 'number') {
        payload.temperature = modelSettings.temperature;
      }
      if (typeof modelSettings.topP === 'number') {
        payload.top_p = modelSettings.topP;
      }
      if (modelSettings.maxOutputLength && modelSettings.maxOutputLength > 0) {
        payload.max_tokens = modelSettings.maxOutputLength;
      }
      if (PROVIDERS_NEEDING_USAGE_FLAG.has(provider.id)) {
        payload.stream_options = { include_usage: true };
      }
      applyThinkingParams(payload, provider.id, modelSettings.thinkingLevel);

      (window as any).electronAPI.chatStream({
        endpoint: provider.endpoint,
        apiKey: provider.apiKey,
        payload,
        streamId,
      }).catch((err: any) => {
        cleanup();
        reject(err);
      });
    });
  }

  // Fallback to non-streaming if chatStream IPC is unavailable
  const responseText = await generateChatResponse(model, messages, modelSettings);
  const parsed = extractThinkingAndContent(responseText);
  onUpdate({
    content: parsed.content,
    thinking: parsed.thinking,
    isGenerating: false,
    toolCalls: parsed.toolCalls,
    isCallingTool: parsed.isCallingTool
  });
  return { content: parsed.content, thinking: parsed.thinking, toolCalls: parsed.toolCalls, isCallingTool: parsed.isCallingTool };
};

export const generateChatResponse = async (
  model: LLMModel,
  messages: any[],
  settings?: ModelSettings
): Promise<string> => {
  const providers = getProviders();
  const provider = providers.find(p => p.id === model.provider);
  if (!provider) throw new Error('Provider not found');

  const modelSettings = settings || getModelSettings();
  const payload: any = {
    model: model.id,
    messages,
  };

  if (typeof modelSettings.temperature === 'number') {
    payload.temperature = modelSettings.temperature;
  }
  if (typeof modelSettings.topP === 'number') {
    payload.top_p = modelSettings.topP;
  }
  if (modelSettings.maxOutputLength && modelSettings.maxOutputLength > 0) {
    payload.max_tokens = modelSettings.maxOutputLength;
  }
  applyThinkingParams(payload, provider.id, modelSettings.thinkingLevel);

  const response = await (window as any).electronAPI.chatComplete({
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    payload
  });

  if (response.success && response.data) {
    recordUsage(provider.id, model.id, response.data.usage);
    const choice = response.data.choices?.[0];
    const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
    const content = choice?.message?.content || '';
    if (reasoning) {
      return `<think>\n${reasoning}\n</think>\n\n${content}`;
    }
    return content;
  } else {
    throw new Error(response.error || 'Unknown error during generation');
  }
};
