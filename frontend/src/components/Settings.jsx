import { useEffect, useMemo, useState } from 'react';
import { api, runtime } from '@/lib/transport';
import './Settings.css';

/* ---- Inline SVG icons (14x14, stroke-based) ---- */
const s = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' };
const Icon = ({ d, ...rest }) => <svg {...s} {...rest}><path d={d} /></svg>;

// Tab icons
const IconGeneral  = () => <Icon d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 4.5v3m0 2.5h.01" />;
const IconModels   = () => <Icon d="M2 4l6-3 6 3v8l-6 3-6-3V4zm6-3v14m6-11l-6 3-6-3" />;
const IconKey      = () => <Icon d="M10.5 2a3.5 3.5 0 00-3.23 4.84L2 12.1V14h2v-1.5h1.5V11H7l1.16-1.27A3.5 3.5 0 1010.5 2zm1 3a1 1 0 100-2 1 1 0 000 2z" />;
const IconAdvanced = () => <Icon d="M6.5 1.5L5.7 3.2 3.8 2.7l-.5 1.9 1.7.8-.3 1.9h2l-.3-1.9 1.7-.8-.5-1.9-1.9.5zm5 5L10.7 8.2l-1.9-.5-.5 1.9 1.7.8-.3 1.9h2l-.3-1.9 1.7-.8-.5-1.9-1.9.5z" />;
const IconInfo     = () => <Icon d="M8 1.5a6.5 6.5 0 110 13 6.5 6.5 0 010-13zm0 4v5m0-7.2h.01" />;

// Action icons
const IconSave     = () => <Icon d="M3 1h8l4 4v8a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2zm5 10a2 2 0 100-4 2 2 0 000 4zM4 1v4h6V1" />;
const IconTest     = () => <Icon d="M13 3l-7.5 7.5L2 7" />;
const IconTrash    = () => <Icon d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4" />;
const IconPlus     = () => <Icon d="M8 3v10M3 8h10" />;
const IconMinus    = () => <Icon d="M3 8h10" />;
const IconReset    = () => <Icon d="M1 4v4h4M15 12V8h-4M13.5 5.5A6 6 0 002.3 7.1m11.4 1.8A6 6 0 012.5 10.5" />;
const IconFolder   = () => <Icon d="M2 4.5V13a1 1 0 001 1h10a1 1 0 001-1V6.5a1 1 0 00-1-1H8.5L7 4H3a1 1 0 00-1 .5z" />;
const IconX        = () => <Icon d="M4 4l8 8M12 4l-8 8" />;
const IconCheck    = () => <Icon d="M13 3l-7.5 7.5L2 7" />;
const IconCopy     = () => <Icon d="M6 2h7a1 1 0 011 1v9a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1zM3 5H2v9a1 1 0 001 1h7v-1" />;
const IconRefresh  = () => <Icon d="M1.5 8a6.5 6.5 0 0111.1-4.6L14 5M14.5 8a6.5 6.5 0 01-11.1 4.6L2 11" />;

const TAB_ICONS = { general: IconGeneral, models: IconModels, credentials: IconKey, advanced: IconAdvanced, info: IconInfo };
const TABS = ['general', 'models', 'credentials', 'advanced', 'info'];

const STORAGE_FIELDS = [
  { key: 'data_dir', label: 'Data Directory' },
  { key: 'conversations_dir', label: 'Conversations' },
  { key: 'uploads_dir', label: 'Uploads' },
  { key: 'config_path', label: 'Config File' },
  { key: 'secrets_path', label: 'Secrets File' },
  { key: 'logs_dir', label: 'Logs Directory' },
];

function withDefaults(config = {}) {
  return {
    council_models: Array.isArray(config.council_models) ? config.council_models : [],
    chairman_model: config.chairman_model || '',
    request_timeout_seconds: Number(config.request_timeout_seconds ?? 120),
    max_parallel_requests: Number(config.max_parallel_requests ?? 8),
    retry_attempts: Number(config.retry_attempts ?? 1),
    retry_backoff_ms: Number(config.retry_backoff_ms ?? 500),
    stage2_enabled: config.stage2_enabled !== false,
    stage3_model_override: config.stage3_model_override || '',
    theme: config.theme || 'system',
    default_export_format: config.default_export_format || 'markdown',
    insights_expanded_default: config.insights_expanded_default === true,
  };
}

const DEFAULT_CONFIG = withDefaults();

const DEFAULT_CREDENTIALS = {
  openrouter_configured: false,
  source: 'missing',
  masked_hint: null,
};

function toUpdatePayload(config) {
  return {
    council_models: config.council_models,
    chairman_model: config.chairman_model,
    request_timeout_seconds: Number(config.request_timeout_seconds),
    max_parallel_requests: Number(config.max_parallel_requests),
    retry_attempts: Number(config.retry_attempts),
    retry_backoff_ms: Number(config.retry_backoff_ms),
    stage2_enabled: Boolean(config.stage2_enabled),
    stage3_model_override: config.stage3_model_override || '',
    theme: config.theme,
    default_export_format: config.default_export_format,
    insights_expanded_default: Boolean(config.insights_expanded_default),
  };
}

function pickDefaults(tab) {
  if (tab === 'general') {
    return {
      theme: DEFAULT_CONFIG.theme,
      default_export_format: DEFAULT_CONFIG.default_export_format,
      insights_expanded_default: DEFAULT_CONFIG.insights_expanded_default,
    };
  }
  if (tab === 'models') {
    return {
      council_models: [...DEFAULT_CONFIG.council_models],
      chairman_model: DEFAULT_CONFIG.chairman_model,
    };
  }
  if (tab === 'advanced') {
    return {
      request_timeout_seconds: DEFAULT_CONFIG.request_timeout_seconds,
      max_parallel_requests: DEFAULT_CONFIG.max_parallel_requests,
      retry_attempts: DEFAULT_CONFIG.retry_attempts,
      retry_backoff_ms: DEFAULT_CONFIG.retry_backoff_ms,
      stage2_enabled: DEFAULT_CONFIG.stage2_enabled,
      stage3_model_override: DEFAULT_CONFIG.stage3_model_override,
    };
  }
  return {};
}

function validateConfig(config) {
  if (!config) return [];

  const issues = [];
  if (config.council_models.length < 1) {
    issues.push('At least one council model is required.');
  }
  if (!config.chairman_model || !config.council_models.includes(config.chairman_model)) {
    issues.push('Chairman model must be one of the council models.');
  }

  const timeout = Number(config.request_timeout_seconds);
  const parallel = Number(config.max_parallel_requests);
  const retries = Number(config.retry_attempts);
  const backoff = Number(config.retry_backoff_ms);

  if (!Number.isFinite(timeout) || timeout < 10 || timeout > 300) {
    issues.push('Request timeout must be between 10 and 300 seconds.');
  }
  if (!Number.isFinite(parallel) || parallel < 1 || parallel > 16) {
    issues.push('Max parallel requests must be between 1 and 16.');
  }
  if (!Number.isFinite(retries) || retries < 0 || retries > 10) {
    issues.push('Retry attempts must be between 0 and 10.');
  }
  if (!Number.isFinite(backoff) || backoff < 0 || backoff > 5000) {
    issues.push('Retry backoff must be between 0 and 5000 ms.');
  }

  return issues;
}

function isApiKeyPlausible(apiKey) {
  const key = apiKey.trim();
  return key.startsWith('sk-or-') && key.length >= 16;
}

export default function Settings({ onClose, onSaved }) {
  const [activeTab, setActiveTab] = useState('models');
  const [config, setConfig] = useState(null);
  const [savedConfig, setSavedConfig] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [newModel, setNewModel] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState(null);
  const [modelsError, setModelsError] = useState(null);

  const [credentials, setCredentials] = useState(DEFAULT_CREDENTIALS);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [openingLogs, setOpeningLogs] = useState(false);
  const [credentialMessage, setCredentialMessage] = useState(null);

  const [notice, setNotice] = useState(null);
  const [storageInfo, setStorageInfo] = useState(null);
  const [storageInfoError, setStorageInfoError] = useState(null);
  const [loadingStorageInfo, setLoadingStorageInfo] = useState(false);
  const [copiedStorageKey, setCopiedStorageKey] = useState(null);

  const isDirty = useMemo(() => {
    if (!config || !savedConfig) return false;
    return JSON.stringify(config) !== JSON.stringify(savedConfig);
  }, [config, savedConfig]);

  const validationIssues = useMemo(() => validateConfig(config), [config]);
  const canResetTab = activeTab === 'general' || activeTab === 'models' || activeTab === 'advanced';

  const applyConfigResponse = (response) => {
    const normalized = withDefaults(response);
    setConfig(normalized);
    setSavedConfig(normalized);
    setCredentials(response.credentials || DEFAULT_CREDENTIALS);
  };

  const applyCredentialStatus = (response) => {
    setCredentials(response.credentials || DEFAULT_CREDENTIALS);
  };

  const reloadCredentialStatus = async () => {
    const cfg = await api.getConfig();
    applyCredentialStatus(cfg);
  };

  const refreshStorageInfo = async () => {
    setLoadingStorageInfo(true);
    setStorageInfoError(null);
    try {
      const info = await api.getStorageInfo();
      setStorageInfo(info);
    } catch (err) {
      setStorageInfoError(err.message || 'Failed to load storage info');
    } finally {
      setLoadingStorageInfo(false);
    }
  };

  useEffect(() => {
    api.getConfig()
      .then((cfg) => applyConfigResponse(cfg))
      .catch(() => setError('Failed to load configuration'));

    setLoadingModels(true);
    api.getAvailableModels()
      .then((models) => setAvailableModels(models))
      .catch(() => setModelsError('Failed to load available models from OpenRouter'))
      .finally(() => setLoadingModels(false));

    setLoadingStorageInfo(true);
    api.getStorageInfo()
      .then((info) => {
        setStorageInfo(info);
        setStorageInfoError(null);
      })
      .catch((err) => setStorageInfoError(err.message || 'Failed to load storage info'))
      .finally(() => setLoadingStorageInfo(false));
  }, []);

  const handleRemoveModel = (model) => {
    setConfig((prev) => {
      const updatedModels = prev.council_models.filter((m) => m !== model);
      const fallbackChairman = updatedModels[0] || '';
      return {
        ...prev,
        council_models: updatedModels,
        chairman_model: updatedModels.includes(prev.chairman_model)
          ? prev.chairman_model
          : fallbackChairman,
      };
    });
  };

  const handleAddModel = () => {
    const model = newModel.trim();
    if (model && config && !config.council_models.includes(model)) {
      setConfig((prev) => ({
        ...prev,
        council_models: [...prev.council_models, model],
        chairman_model: prev.chairman_model || model,
      }));
      setNewModel('');
    }
  };

  const handleRestoreTabDefaults = () => {
    if (!config) return;
    const defaults = pickDefaults(activeTab);
    setConfig((prev) => ({ ...prev, ...defaults }));
    setNotice(`Restored ${activeTab} defaults.`);
  };

  const handleRestoreAllDefaults = () => {
    setConfig(withDefaults(DEFAULT_CONFIG));
    setNotice('Restored all defaults. Save to apply.');
  };

  const handleSave = async () => {
    if (!config) return;
    if (validationIssues.length > 0) {
      setError(validationIssues[0]);
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await api.updateConfig(toUpdatePayload(config));
      applyConfigResponse(response);
      onSaved?.(response);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (savedConfig) {
      setConfig(savedConfig);
    }
    onClose();
  };

  const handleSetApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!trimmed) {
      setCredentialMessage('Enter an API key before saving.');
      return;
    }
    if (!isApiKeyPlausible(trimmed)) {
      setCredentialMessage('API key format looks invalid. Expected prefix: sk-or-.');
      return;
    }

    setCredentialBusy(true);
    setCredentialMessage(null);
    try {
      const response = await api.setOpenRouterApiKey(trimmed);
      applyCredentialStatus(response);
      setApiKeyInput('');
      setCredentialMessage('OpenRouter API key saved.');
    } catch (err) {
      setCredentialMessage(err.message || 'Failed to save API key.');
    } finally {
      setCredentialBusy(false);
    }
  };

  const handleClearApiKey = async () => {
    setCredentialBusy(true);
    setCredentialMessage(null);
    try {
      const response = await api.clearOpenRouterApiKey();
      applyCredentialStatus(response);
      setApiKeyInput('');
      setCredentialMessage('Stored API key cleared.');
    } catch (err) {
      setCredentialMessage(err.message || 'Failed to clear API key.');
    } finally {
      setCredentialBusy(false);
    }
  };

  const handleTestApiKey = async () => {
    setCredentialBusy(true);
    setCredentialMessage(null);
    try {
      const keyToTest = apiKeyInput.trim();
      if (keyToTest && !isApiKeyPlausible(keyToTest)) {
        setCredentialMessage('API key format looks invalid. Expected prefix: sk-or-.');
        return;
      }

      await api.testOpenRouterApiKey(keyToTest);
      setCredentialMessage('OpenRouter connection test succeeded.');
      if (!keyToTest) {
        await reloadCredentialStatus();
      }
    } catch (err) {
      setCredentialMessage(err.message || 'OpenRouter connection test failed.');
    } finally {
      setCredentialBusy(false);
    }
  };

  const handleOpenLogsFolder = async () => {
    setOpeningLogs(true);
    setCredentialMessage(null);
    try {
      await api.openLogsFolder();
      setCredentialMessage('Opened logs folder.');
    } catch (err) {
      setCredentialMessage(err.message || 'Failed to open logs folder.');
    } finally {
      setOpeningLogs(false);
    }
  };

  const handleCopyStoragePath = async (key, value) => {
    const pathValue = typeof value === 'string' ? value.trim() : '';
    if (!pathValue) return;
    if (!navigator?.clipboard?.writeText) {
      setNotice('Clipboard API unavailable in this environment.');
      return;
    }
    try {
      await navigator.clipboard.writeText(pathValue);
      setCopiedStorageKey(key);
      setNotice(`Copied ${key.replace('_', ' ')}.`);
      setTimeout(() => setCopiedStorageKey((prev) => (prev === key ? null : prev)), 1200);
    } catch {
      setNotice('Failed to copy path.');
    }
  };

  // ---- Loading state ----
  if (!config) {
    return (
      <div className="settings-overlay" onClick={onClose}>
        <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
          <div className="settings-header">
            <h2>Settings</h2>
            <button className="settings-close" onClick={onClose}>&times;</button>
          </div>
          <div className="settings-body">
            {error ? <div className="settings-error">{error}</div> : <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading...</p>}
          </div>
        </div>
      </div>
    );
  }

  // ---- Main render ----
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-tabs">
          {TABS.map((tab) => {
            const TabIcon = TAB_ICONS[tab];
            return (
              <button
                key={tab}
                type="button"
                className={`settings-tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab(tab);
                  setNotice(null);
                  setError(null);
                }}
              >
                <TabIcon />
                {tab[0].toUpperCase() + tab.slice(1)}
              </button>
            );
          })}
        </div>

        <div className="settings-body">
          {error && <div className="settings-error">{error}</div>}
          {validationIssues.length > 0 && !error && (
            <div className="settings-error">{validationIssues[0]}</div>
          )}
          {notice && <div className="settings-note">{notice}</div>}

          {/* ---- General ---- */}
          {activeTab === 'general' && (
            <div className="settings-section">
              <h3>Appearance</h3>
              <div className="settings-field">
                <span>Theme</span>
                <div className="theme-toggle">
                  {['system', 'light', 'dark'].map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`theme-toggle-btn ${config.theme === value ? 'active' : ''}`}
                      onClick={() => setConfig((prev) => ({ ...prev, theme: value }))}
                    >
                      {value === 'light' && (
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="8" cy="8" r="3" />
                          <path d="M8 1v2m0 10v2M3.05 3.05l1.41 1.41m7.08 7.08l1.41 1.41M1 8h2m10 0h2M3.05 12.95l1.41-1.41m7.08-7.08l1.41-1.41" />
                        </svg>
                      )}
                      {value === 'dark' && (
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 8.5A6.5 6.5 0 017.5 2 5.5 5.5 0 1014 8.5z" />
                        </svg>
                      )}
                      {value === 'system' && (
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="1.5" y="2" width="13" height="10" rx="1.5" />
                          <path d="M5 14h6" />
                        </svg>
                      )}
                      {value[0].toUpperCase() + value.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
              <label className="settings-field">
                <span>Default Export Format</span>
                <select
                  value={config.default_export_format}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, default_export_format: e.target.value }))
                  }
                >
                  <option value="markdown">Markdown</option>
                </select>
              </label>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={config.insights_expanded_default}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, insights_expanded_default: e.target.checked }))
                  }
                />
                <span>Expand insights by default</span>
              </label>
            </div>
          )}

          {/* ---- Models ---- */}
          {activeTab === 'models' && (
            <div className="settings-section">
              <h3>Council Models</h3>
              <div className="model-list">
                {config.council_models.map((model) => (
                  <div key={model} className="model-item">
                    <span className="model-id">{model}</span>
                    <button className="model-remove" onClick={() => handleRemoveModel(model)} title="Remove model">
                      <IconMinus />
                    </button>
                  </div>
                ))}
              </div>

              <div className="model-add">
                <input
                  list="available-models"
                  value={newModel}
                  onChange={(e) => setNewModel(e.target.value)}
                  placeholder={loadingModels ? 'Loading models...' : 'Type or select model ID...'}
                  className="model-input"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddModel()}
                />
                <datalist id="available-models">
                  {availableModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </datalist>
                <button className="model-add-btn" onClick={handleAddModel} title="Add model">
                  <IconPlus /> Add
                </button>
              </div>
              {modelsError && (
                <div className="settings-error" style={{ marginTop: 8 }}>
                  {modelsError} (you can still type model IDs manually)
                </div>
              )}

              <h3>Chairman Model</h3>
              <select
                value={config.chairman_model}
                onChange={(e) => setConfig((prev) => ({ ...prev, chairman_model: e.target.value }))}
                className="chairman-select"
              >
                {config.council_models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* ---- Credentials ---- */}
          {activeTab === 'credentials' && (
            <div className="settings-section">
              <h3>OpenRouter Credentials</h3>
              <div className="credential-status">
                <span
                  className={`credential-status-badge ${credentials.openrouter_configured ? 'configured' : 'missing'}`}
                >
                  <span className="credential-status-dot" />
                  {credentials.openrouter_configured ? 'Configured' : 'Not configured'}
                </span>
                <span>Source: {credentials.source || 'none'}</span>
                {credentials.masked_hint && (
                  <span className="credential-hint">{credentials.masked_hint}</span>
                )}
              </div>

              <label className="settings-field">
                <span>OpenRouter API Key</span>
                <input
                  type="password"
                  value={apiKeyInput}
                  placeholder="sk-or-v1-..."
                  onChange={(e) => setApiKeyInput(e.target.value)}
                />
              </label>

              <div className="settings-actions-inline">
                <button
                  type="button"
                  className="btn-inline primary"
                  onClick={handleSetApiKey}
                  disabled={credentialBusy}
                >
                  <IconSave /> Save Key
                </button>
                <button
                  type="button"
                  className="btn-inline"
                  onClick={handleTestApiKey}
                  disabled={credentialBusy}
                >
                  <IconTest /> Test Key
                </button>
                <button
                  type="button"
                  className="btn-inline danger"
                  onClick={handleClearApiKey}
                  disabled={credentialBusy}
                >
                  <IconTrash /> Clear Key
                </button>
              </div>

              {credentialMessage && <div className="settings-note">{credentialMessage}</div>}
            </div>
          )}

          {/* ---- Advanced ---- */}
          {activeTab === 'advanced' && (
            <div className="settings-section">
              <h3>Runtime</h3>
              <label className="settings-field">
                <span>Request Timeout (seconds)</span>
                <input
                  type="number"
                  min="10"
                  max="300"
                  value={config.request_timeout_seconds}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      request_timeout_seconds: Number(e.target.value),
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Max Parallel Requests</span>
                <input
                  type="number"
                  min="1"
                  max="16"
                  value={config.max_parallel_requests}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      max_parallel_requests: Number(e.target.value),
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Retry Attempts</span>
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={config.retry_attempts}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      retry_attempts: Number(e.target.value),
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Retry Backoff (ms)</span>
                <input
                  type="number"
                  min="0"
                  max="5000"
                  value={config.retry_backoff_ms}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      retry_backoff_ms: Number(e.target.value),
                    }))
                  }
                />
              </label>

              <h3>Stages</h3>
              <label className="settings-checkbox">
                <input
                  type="checkbox"
                  checked={config.stage2_enabled}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, stage2_enabled: e.target.checked }))
                  }
                />
                <span>Enable Stage 2 ranking</span>
              </label>
              <label className="settings-field">
                <span>Stage 3 Model Override (optional)</span>
                <input
                  type="text"
                  value={config.stage3_model_override}
                  placeholder="Leave blank to use chairman model"
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, stage3_model_override: e.target.value }))
                  }
                />
              </label>
            </div>
          )}

          {/* ---- Info ---- */}
          {activeTab === 'info' && (
            <div className="settings-section">
              <div className="settings-section-header-row">
                <h3>Storage Artifacts</h3>
                <button
                  type="button"
                  className="btn-inline"
                  onClick={refreshStorageInfo}
                  disabled={loadingStorageInfo}
                >
                  <IconRefresh /> {loadingStorageInfo ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
              <p className="settings-info-intro">
                These are the active paths used by this runtime for conversations, uploads, logs,
                and local config/credentials files.
              </p>

              {storageInfoError && (
                <div className="settings-error">{storageInfoError}</div>
              )}

              {!storageInfo && loadingStorageInfo && (
                <p className="settings-info-loading">Loading storage paths...</p>
              )}

              {storageInfo && (
                <>
                  <div className="storage-runtime-chip">
                    Runtime: {storageInfo.runtime || runtime}
                  </div>
                  <div className="storage-info-list">
                    {STORAGE_FIELDS.map((field) => {
                      const value = storageInfo[field.key];
                      const hasPath = typeof value === 'string' && value.trim().length > 0;
                      return (
                        <div key={field.key} className="storage-info-item">
                          <div className="storage-info-item-main">
                            <span className="storage-info-label">{field.label}</span>
                            <code className="storage-info-path">{hasPath ? value : '(not available)'}</code>
                          </div>
                          <button
                            type="button"
                            className="btn-inline storage-copy-btn"
                            onClick={() => handleCopyStoragePath(field.key, value)}
                            disabled={!hasPath}
                          >
                            <IconCopy /> {copiedStorageKey === field.key ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {storageInfo.logs_note && (
                    <div className="settings-note">{storageInfo.logs_note}</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* ---- Footer ---- */}
        <div className="settings-footer">
          <div className="settings-footer-secondary">
            <button
              className="btn-ghost btn-icon"
              onClick={handleRestoreTabDefaults}
              title="Restore defaults for this tab"
              disabled={!canResetTab}
            >
              <IconReset /> Reset Tab
            </button>
            <button className="btn-ghost btn-icon" onClick={handleRestoreAllDefaults} title="Restore all settings to defaults">
              <IconReset /> Reset All
            </button>
            {runtime === 'tauri' && (
              <button
                className="btn-ghost btn-icon"
                onClick={handleOpenLogsFolder}
                disabled={openingLogs}
                title="Open application logs folder"
              >
                <IconFolder />
                {openingLogs ? 'Opening...' : 'Logs'}
              </button>
            )}
          </div>
          <div className="settings-footer-primary">
            <button className="btn-cancel btn-icon" onClick={handleCancel}>
              <IconX /> Cancel
            </button>
            <button
              className="btn-save btn-icon"
              onClick={handleSave}
              disabled={saving || !isDirty || validationIssues.length > 0}
            >
              <IconCheck /> {saving ? 'Saving...' : isDirty ? 'Save' : 'Saved'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
