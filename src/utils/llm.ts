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
}

// Generates a streaming chat completion, feeding thinking and response deltas in real-time
export const generateChatStream = async (
  model: LLMModel,
  messages: any[],
  onUpdate: (update: StreamUpdate) => void,
  signal?: AbortSignal
): Promise<{ content: string; thinking: string }> => {
  const providers = getProviders();
  const provider = providers.find(p => p.id === model.provider);
  if (!provider) throw new Error('Provider not found');

  const streamId = Math.random().toString(36).substring(7);
  let accumulatedContent = '';
  let accumulatedReasoning = '';

  const processAndEmit = () => {
    // If thinking tags are embedded in the content string (e.g. <think>...</think>)
    const parsed = extractThinkingAndContent(accumulatedContent);
    const combinedThinking = [accumulatedReasoning, parsed.thinking].filter(Boolean).join('\n\n').trim();
    const finalContent = parsed.content;

    onUpdate({
      content: finalContent,
      thinking: combinedThinking,
      isGenerating: true,
    });
  };

  if ((window as any).electronAPI?.chatStream) {
    return new Promise((resolve, reject) => {
      let cleanupDelta: (() => void) | undefined;
      let cleanupEnd: (() => void) | undefined;
      let cleanupError: (() => void) | undefined;

      const cleanup = () => {
        if (cleanupDelta) cleanupDelta();
        if (cleanupEnd) cleanupEnd();
        if (cleanupError) cleanupError();
      };

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
        }
        processAndEmit();
      });

      cleanupEnd = (window as any).electronAPI.onStreamEnd((data: any) => {
        if (data.streamId !== streamId) return;
        cleanup();
        const parsed = extractThinkingAndContent(accumulatedContent);
        const combinedThinking = [accumulatedReasoning, parsed.thinking].filter(Boolean).join('\n\n').trim();
        onUpdate({
          content: parsed.content,
          thinking: combinedThinking,
          isGenerating: false,
        });
        resolve({ content: parsed.content, thinking: combinedThinking });
      });

      cleanupError = (window as any).electronAPI.onStreamError((data: any) => {
        if (data.streamId !== streamId) return;
        cleanup();
        reject(new Error(data.error || 'Streaming error occurred'));
      });

      const payload = {
        model: model.id,
        messages,
      };

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
  const responseText = await generateChatResponse(model, messages);
  const parsed = extractThinkingAndContent(responseText);
  onUpdate({
    content: parsed.content,
    thinking: parsed.thinking,
    isGenerating: false,
  });
  return parsed;
};

export const generateChatResponse = async (
  model: LLMModel,
  messages: any[]
): Promise<string> => {
  const providers = getProviders();
  const provider = providers.find(p => p.id === model.provider);
  if (!provider) throw new Error('Provider not found');

  const payload = {
    model: model.id,
    messages,
  };

  const response = await (window as any).electronAPI.chatComplete({
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    payload
  });

  if (response.success && response.data) {
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
