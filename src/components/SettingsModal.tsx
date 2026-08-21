import React, { useState, useEffect } from 'react';
import { X, Save, Settings2, Globe } from 'lucide-react';
import { LLMProvider, getProviders, saveProviders, WebSearchSettings, getWebSearchSettings, saveWebSearchSettings } from '../utils/llm';

interface SettingsModalProps {
  onClose: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [webSearch, setWebSearch] = useState<WebSearchSettings>({ endpoint: '', apiKey: '' });

  useEffect(() => {
    setProviders(getProviders());
    setWebSearch(getWebSearchSettings());
  }, []);

  const handleProviderChange = (index: number, field: keyof LLMProvider, value: any) => {
    const newProviders = [...providers];
    newProviders[index] = { ...newProviders[index], [field]: value };
    setProviders(newProviders);
  };

  const handleSave = () => {
    saveProviders(providers);
    saveWebSearchSettings(webSearch);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[500] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="menu-panel rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
        
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-white/10 bg-black/20">
          <div className="flex items-center gap-3 text-white">
            <Settings2 size={22} className="text-accentBright" />
            <h2 className="text-xl font-medium">Settings</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors text-textSecondary hover:text-white">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          
          <div>
            <h3 className="text-white font-medium mb-4 flex items-center gap-2">
              LLM Providers
            </h3>
            <p className="text-sm text-textSecondary mb-6">
              Configure endpoints and API keys for OpenAI-compatible APIs. 
              Local endpoints (Ollama, LM Studio) do not require API keys.
            </p>

            <div className="space-y-6">
              {providers.map((provider, idx) => (
                <div key={provider.id} className="p-4 rounded-xl border border-white/5 bg-black/20 space-y-4">
                  
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <input 
                        type="checkbox"
                        checked={provider.enabled}
                        onChange={(e) => handleProviderChange(idx, 'enabled', e.target.checked)}
                        className="w-4 h-4 rounded bg-black border-gray-600 checked:bg-accent"
                        id={`enable-${provider.id}`}
                      />
                      <label htmlFor={`enable-${provider.id}`} className="text-white font-medium select-none cursor-pointer">
                        {provider.name}
                      </label>
                    </div>
                  </div>

                  {provider.enabled && (
                    <div className="space-y-3 pl-7">
                      <div className="flex flex-col gap-1">
                        <label className="menu-header">Endpoint URL</label>
                        <input 
                          type="text" 
                          value={provider.endpoint}
                          onChange={(e) => handleProviderChange(idx, 'endpoint', e.target.value)}
                          className="input-field"
                          placeholder="e.g. https://api.openai.com/v1"
                        />
                      </div>
                      
                      <div className="flex flex-col gap-1">
                        <label className="menu-header">API Key</label>
                        <input 
                          type="password" 
                          value={provider.apiKey}
                          onChange={(e) => handleProviderChange(idx, 'apiKey', e.target.value)}
                          className="input-field"
                          placeholder="Leave blank for local servers"
                        />
                      </div>
                    </div>
                  )}

                </div>
              ))}
            </div>
          </div>

          <div>
            <h3 className="text-white font-medium mb-4 flex items-center gap-2">
              <Globe size={18} className="text-accentBright" />
              Web Search
            </h3>
            <p className="text-sm text-textSecondary mb-4">
              Optional search API provider. When configured, the agent gets a direct
              <span className="font-mono text-xs text-textSecondary"> search_web </span>
              tool. When left empty (default), the agent searches by driving the embedded
              browser instead — you can watch it live in the tool call view.
            </p>

            <div className="p-4 rounded-xl border border-white/5 bg-black/20 space-y-3">
              <div className="flex flex-col gap-1">
                <label className="menu-header">Search Endpoint URL</label>
                <input
                  type="text"
                  value={webSearch.endpoint}
                  onChange={(e) => setWebSearch({ ...webSearch, endpoint: e.target.value })}
                  className="input-field"
                  placeholder="Leave empty to use the embedded browser for search"
                />
                <span className="text-[11px] text-textSecondary/70">
                  Receives POST {'{ query, limit }'} with a Bearer token; return JSON results.
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <label className="menu-header">API Key</label>
                <input
                  type="password"
                  value={webSearch.apiKey}
                  onChange={(e) => setWebSearch({ ...webSearch, apiKey: e.target.value })}
                  className="input-field"
                  placeholder="Sent as Authorization: Bearer &lt;key&gt;"
                />
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="p-5 border-t border-white/10 bg-black/20 flex justify-end gap-3 rounded-b-2xl">
          <button 
            onClick={onClose}
            className="px-5 py-2 rounded-xl text-sm font-medium text-textSecondary hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium bg-accent text-white hover:bg-accentHover transition-colors shadow-lg shadow-accent/20"
          >
            <Save size={16} />
            Save Configuration
          </button>
        </div>

      </div>
    </div>
  );
};

export default SettingsModal;
