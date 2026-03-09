import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigResponse, CredentialsStatus, StorageInfo } from '@/types/api';

const { mockApi, runtimeState } = vi.hoisted(() => ({
  mockApi: {
    getConfig: vi.fn(),
    getAvailableModels: vi.fn(),
    getStorageInfo: vi.fn(),
    updateConfig: vi.fn(),
    setOpenRouterApiKey: vi.fn(),
    clearOpenRouterApiKey: vi.fn(),
    testOpenRouterApiKey: vi.fn(),
    openLogsFolder: vi.fn(),
  },
  runtimeState: { value: 'web' as 'web' | 'tauri' },
}));

vi.mock('@/lib/transport', () => ({
  api: mockApi,
  get runtime() {
    return runtimeState.value;
  },
}));

import Settings from './Settings';

const baseCredentials: CredentialsStatus = {
  openrouter_configured: true,
  source: 'stored',
  masked_hint: 'sk-or-***',
};

const baseConfig: AppConfigResponse = {
  council_models: ['provider/model-a', 'provider/model-b'],
  chairman_model: 'provider/model-a',
  request_timeout_seconds: 120,
  max_parallel_requests: 8,
  retry_attempts: 1,
  retry_backoff_ms: 500,
  stage2_enabled: true,
  stage3_model_override: '',
  theme: 'system',
  default_export_format: 'markdown',
  insights_expanded_default: false,
  credentials: baseCredentials,
};

const baseStorage: StorageInfo = {
  runtime: 'web',
  data_dir: '/tmp/data',
  conversations_dir: '/tmp/data/conversations',
  uploads_dir: '/tmp/data/uploads',
  config_path: '/tmp/data/config.json',
  secrets_path: '/tmp/data/secrets.json',
  logs_dir: '/tmp/data/logs',
  logs_note: 'logs are local',
};

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.value = 'web';

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    mockApi.getConfig.mockResolvedValue({ ...baseConfig });
    mockApi.getAvailableModels.mockResolvedValue([
      { id: 'provider/model-a', name: 'Model A' },
      { id: 'provider/model-b', name: 'Model B' },
      { id: 'provider/model-c', name: 'Model C' },
    ]);
    mockApi.getStorageInfo.mockResolvedValue({ ...baseStorage });
    mockApi.updateConfig.mockImplementation(async (payload: Partial<AppConfigResponse>) => ({
      ...baseConfig,
      ...payload,
      credentials: baseCredentials,
    }));
    mockApi.setOpenRouterApiKey.mockResolvedValue({
      ...baseConfig,
      credentials: { ...baseCredentials, openrouter_configured: true, source: 'stored' },
    });
    mockApi.clearOpenRouterApiKey.mockResolvedValue({
      ...baseConfig,
      credentials: { openrouter_configured: false, source: 'missing', masked_hint: null },
    });
    mockApi.testOpenRouterApiKey.mockResolvedValue({ ok: true });
    mockApi.openLogsFolder.mockResolvedValue({ ok: true });
  });

  function renderSettings() {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<Settings onClose={onClose} onSaved={onSaved} />);
    return { onClose, onSaved };
  }

  it('shows load error state when config fetch fails', async () => {
    mockApi.getConfig.mockRejectedValueOnce(new Error('boom'));
    renderSettings();

    expect(await screen.findByText('Failed to load configuration')).toBeInTheDocument();
  });

  it('adds/removes models and saves updated config', async () => {
    const { onClose, onSaved } = renderSettings();

    await screen.findByText('Council Models');
    const addInput = screen.getByPlaceholderText(/Type or select model ID/i);

    fireEvent.change(addInput, { target: { value: 'provider/model-c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(
      screen
        .getAllByText('provider/model-c')
        .some((node) => node.classList.contains('model-id'))
    ).toBe(true);

    fireEvent.click(screen.getAllByTitle('Remove model')[0]!);
    expect(screen.queryByText('provider/model-a')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(mockApi.updateConfig).toHaveBeenCalledTimes(1);
      const payload = mockApi.updateConfig.mock.calls[0]?.[0];
      expect(payload.council_models).toEqual(['provider/model-b', 'provider/model-c']);
      expect(payload.chairman_model).toBe('provider/model-b');
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('shows validation issues and disables save for invalid advanced inputs', async () => {
    renderSettings();
    await screen.findByText('Council Models');

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    const timeoutInput = screen.getByLabelText('Request Timeout (seconds)');
    fireEvent.change(timeoutInput, { target: { value: '5' } });

    expect(await screen.findByText('Request timeout must be between 10 and 300 seconds.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('handles credential actions and messages', async () => {
    renderSettings();
    await screen.findByText('Council Models');

    fireEvent.click(screen.getByRole('button', { name: 'Credentials' }));
    await screen.findByText('OpenRouter Credentials');

    fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));
    expect(screen.getByText('Enter an API key before saving.')).toBeInTheDocument();

    const keyInput = screen.getByPlaceholderText('sk-or-v1-...');
    fireEvent.change(keyInput, { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));
    expect(screen.getByText('API key format looks invalid. Expected prefix: sk-or-.')).toBeInTheDocument();

    fireEvent.change(keyInput, { target: { value: 'sk-or-12345678901234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Key' }));
    await waitFor(() => {
      expect(mockApi.setOpenRouterApiKey).toHaveBeenCalledWith('sk-or-12345678901234');
      expect(screen.getByText('OpenRouter API key saved.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Test Key' }));
    await waitFor(() => {
      expect(mockApi.testOpenRouterApiKey).toHaveBeenCalledWith('');
      expect(screen.getByText('OpenRouter connection test succeeded.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear Key' }));
    await waitFor(() => {
      expect(mockApi.clearOpenRouterApiKey).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Stored API key cleared.')).toBeInTheDocument();
    });
  });

  it('supports info tab refresh, copy, and open-logs actions in tauri runtime', async () => {
    runtimeState.value = 'tauri';
    mockApi.getStorageInfo.mockResolvedValue({
      ...baseStorage,
      runtime: 'tauri',
    });

    renderSettings();
    await screen.findByText('Council Models');
    fireEvent.click(screen.getByRole('button', { name: 'Info' }));
    await screen.findByText('Storage Artifacts');

    fireEvent.click(screen.getByRole('button', { name: /^Refresh$/ }));
    await waitFor(() => {
      expect(mockApi.getStorageInfo).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy' })[0]!);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('/tmp/data');
      expect(screen.getByText('Copied data dir.')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open Logs Folder' }));
    await waitFor(() => {
      expect(mockApi.openLogsFolder).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Opened logs folder.')).toBeInTheDocument();
    });
  });
});
