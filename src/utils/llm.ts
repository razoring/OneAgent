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

// Convert local file to base64 for vision models
export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = error => reject(error);
  });
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
    return response.data.choices[0]?.message?.content || '';
  } else {
    throw new Error(response.error || 'Unknown error during generation');
  }
};
