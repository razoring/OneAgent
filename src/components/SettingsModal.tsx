import React, { useState, useEffect } from 'react';
import { X, Save, Settings2, Globe, Monitor } from 'lucide-react';
import { LLMProvider, getProviders, saveProviders, WebSearchSettings, getWebSearchSettings, saveWebSearchSettings, BrowserSettings, getBrowserSettings, saveBrowserSettings } from '../utils/llm';

interface SettingsModalProps {
  onClose: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ onClose }) => {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [webSearch, setWebSearch] = useState<WebSearchSettings>({ endpoint: '', apiKey: '' });
  const [browser, setBrowser] = useState<BrowserSettings>({ chromiumPath: '', cdpPort: 9222, launchArgs: '' });

  useEffect(() => {
    setProviders(getProviders());
    setWebSearch(getWebSearchSettings());
    setBrowser(getBrowserSettings());
  }, []);

  const handleProviderChange = (index: number, field: keyof LLMProvider, value: any) => {
    const newProviders = [...providers];
    newProviders[index] = { ...newProviders[index], [field]: value };
    setProviders(newProviders);
  };

  const handleSave = () => {
    saveProviders(providers);
    saveWebSearchSettings(webSearch);
    saveBrowserSettings(browser);
    onClose();
  };

  const handleBrowseChromium = async () => {
    try {
      const api: any = (window as any).electronAPI;
      if (api?.dialogShowOpen) {
        const res = await api.dialogShowOpen({ properties: ['openFile'] });
        if (res && !res.canceled && res.filePaths && res.filePaths[0]) {
          setBrowser({ ...browser, chromiumPath: res.filePaths[0] });
        }
      }
    } catch (e) { console.error('[Settings] browse chromium failed', e); }
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

          <div>
            <h3 className="text-white font-medium mb-4 flex items-center gap-2">
              <Monitor size={18} className="text-accentBright" />
              Browser — External Chromium (CDP)
            </h3>
            <p className="text-sm text-textSecondary mb-4">
              Launch any Chromium browser (Chrome, Edge, Brave, Vivaldi) with <span className="font-mono text-xs">--remote-debugging-port</span> on demand. Leave blank to auto-detect on first <span className="font-mono text-xs">Browser</span> click. The agent then drives parallel CDP Targets in the <span className="font-mono text-xs">live profile</span> via <span className="font-mono text-xs">ws://127.0.0.1:PORT/json</span>. No extension, no banner — <span className="font-mono text-xs">--enable-automation</span> is never set. Instance is left running on quit.
            </p>
            <div className="p-4 rounded-xl border border-white/5 bg-black/20 space-y-3">
              <div className="flex flex-col gap-1">
                <label className="menu-header">Chromium Executable Path</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={browser.chromiumPath}
                    onChange={(e) => setBrowser({ ...browser, chromiumPath: e.target.value })}
                    className="input-field flex-1"
                    placeholder="Auto-detect — e.g. C:\Program Files\Google\Chrome\Application\chrome.exe"
                  />
                  <button
                    type="button"
                    onClick={handleBrowseChromium}
                    className="px-3 py-2 rounded-xl text-xs font-medium bg-white/10 hover:bg-white/15 text-white transition-colors shrink-0"
                  >
                    Browse…
                  </button>
                </div>
                <span className="text-[11px] text-textSecondary/70">Supports .lnk shortcuts (TargetPath + Args are merged).</span>
              </div>
              <div className="flex gap-3">
                <div className="flex flex-col gap-1 flex-1">
                  <label className="menu-header">CDP Port</label>
                  <input
                    type="number"
                    value={browser.cdpPort}
                    onChange={(e) => setBrowser({ ...browser, cdpPort: Math.max(1024, Math.min(65535, Number(e.target.value)||9222)) })}
                    className="input-field"
                    placeholder="9222"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-[2]">
                  <label className="menu-header">Extra Launch Args (optional)</label>
                  <input
                    type="text"
                    value={browser.launchArgs}
                    onChange={(e) => setBrowser({ ...browser, launchArgs: e.target.value })}
                    className="input-field"
                    placeholder="e.g. --ozone-platform-hint=auto"
                  />
                </div>
              </div>
              <span className="text-[11px] text-textSecondary/70">Chrome/Edge/Brave/Vivaldi/Chromium all use <span className="font-mono">--remote-debugging-port=PORT --remote-allow-origins=*</span>. First click auto-detects installed browsers.</span>
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
