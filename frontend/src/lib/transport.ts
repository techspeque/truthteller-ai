import { log } from '@/lib/logger';
import type {
  Conversation,
  ConversationSummary,
  AppConfigResponse,
  StorageInfo,
  AppConfig,
  AvailableModel,
  RerunResponse,
} from '@/types/api';
import type { CouncilStreamEvent, CouncilEventType } from '@/types/events';

const API_BASE = 'http://localhost:8001';

type Runtime = 'tauri' | 'web';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function detectRuntime(): Runtime {
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    return 'tauri';
  }
  return 'web';
}

function buildMessageRequestOptions(content: string, files: File[] = []): RequestInit {
  if (files && files.length > 0) {
    const formData = new FormData();
    formData.append('content', content);
    files.forEach((file) => formData.append('files', file));
    return {
      method: 'POST',
      body: formData,
    };
  }
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  };
}

async function throwDetailedError(response: Response, fallback: string): Promise<never> {
  let detail = '';
  try {
    const json = await response.json();
    detail = json?.detail || json?.message || '';
  } catch {
    try {
      detail = await response.text();
    } catch {
      detail = '';
    }
  }
  throw new Error(detail || fallback);
}

export type StreamEventCallback = (eventType: CouncilEventType, event: CouncilStreamEvent) => void;

export interface Transport {
  healthCheck(): Promise<unknown>;
  listConversations(): Promise<ConversationSummary[]>;
  createConversation(): Promise<Conversation>;
  getConversation(conversationId: string): Promise<Conversation>;
  deleteConversation(conversationId: string): Promise<unknown>;
  sendMessage(conversationId: string, content: string, files?: File[]): Promise<unknown>;
  sendMessageStream(conversationId: string, content: string, files: File[], onEvent: StreamEventCallback): Promise<void>;
  getConfig(): Promise<AppConfigResponse>;
  getStorageInfo(): Promise<StorageInfo>;
  updateConfig(config: Partial<AppConfig>): Promise<AppConfigResponse>;
  setOpenRouterApiKey(apiKey: string): Promise<AppConfigResponse>;
  clearOpenRouterApiKey(): Promise<AppConfigResponse>;
  testOpenRouterApiKey(apiKey?: string): Promise<unknown>;
  getAvailableModels(): Promise<AvailableModel[]>;
  retryModels(conversationId: string, models: string[], userQuery: string): Promise<unknown>;
  rerunAssistant(conversationId: string, payload: unknown): Promise<RerunResponse>;
  openLogsFolder(): Promise<unknown>;
}

const httpTransport: Transport = {
  async healthCheck() {
    const response = await fetch(`${API_BASE}/`);
    if (!response.ok) throw new Error('Backend unavailable');
    return response.json();
  },

  async listConversations() {
    const response = await fetch(`${API_BASE}/api/conversations`);
    if (!response.ok) throw new Error('Failed to list conversations');
    return response.json();
  },

  async createConversation() {
    const response = await fetch(`${API_BASE}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error('Failed to create conversation');
    return response.json();
  },

  async getConversation(conversationId: string) {
    const response = await fetch(`${API_BASE}/api/conversations/${conversationId}`);
    if (!response.ok) throw new Error('Failed to get conversation');
    return response.json();
  },

  async deleteConversation(conversationId: string) {
    const response = await fetch(`${API_BASE}/api/conversations/${conversationId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete conversation');
    return response.json();
  },

  async sendMessage(conversationId: string, content: string, files: File[] = []) {
    const hasFiles = files && files.length > 0;
    const url = hasFiles
      ? `${API_BASE}/api/conversations/${conversationId}/message/upload`
      : `${API_BASE}/api/conversations/${conversationId}/message`;
    const response = await fetch(url, buildMessageRequestOptions(content, files));
    if (!response.ok) throw new Error('Failed to send message');
    return response.json();
  },

  async sendMessageStream(conversationId: string, content: string, files: File[] = [], onEvent: StreamEventCallback) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/message/stream`,
      buildMessageRequestOptions(content, files)
    );
    if (!response.ok) throw new Error('Failed to send message');
    if (!response.body) throw new Error('Missing response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pendingLine = '';

    const parseLine = (rawLine: string) => {
      const line = rawLine.replace(/\r$/, '');
      if (!line.startsWith('data: ')) return;
      const data = line.slice(6);
      try {
        const event = JSON.parse(data) as CouncilStreamEvent;
        onEvent(event.type, event);
      } catch (e) {
        log.warn('Failed to parse SSE event', { error: (e as Error).message, data });
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      pendingLine += decoder.decode(value, { stream: true });
      const lines = pendingLine.split('\n');
      pendingLine = lines.pop() || '';
      lines.forEach(parseLine);
    }

    pendingLine += decoder.decode();
    if (pendingLine) parseLine(pendingLine);
  },

  async getConfig() {
    const response = await fetch(`${API_BASE}/api/config`);
    if (!response.ok) throw new Error('Failed to get config');
    return response.json();
  },

  async getStorageInfo() {
    const response = await fetch(`${API_BASE}/api/storage/info`);
    if (!response.ok) throw new Error('Failed to get storage info');
    return response.json();
  },

  async updateConfig(config: Partial<AppConfig>) {
    const response = await fetch(`${API_BASE}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!response.ok) await throwDetailedError(response, 'Failed to update config');
    return response.json();
  },

  async setOpenRouterApiKey(apiKey: string) {
    const response = await fetch(`${API_BASE}/api/config/credentials/openrouter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) await throwDetailedError(response, 'Failed to save OpenRouter API key');
    return response.json();
  },

  async clearOpenRouterApiKey() {
    const response = await fetch(`${API_BASE}/api/config/credentials/openrouter`, {
      method: 'DELETE',
    });
    if (!response.ok) await throwDetailedError(response, 'Failed to clear OpenRouter API key');
    return response.json();
  },

  async testOpenRouterApiKey(apiKey: string = '') {
    const response = await fetch(`${API_BASE}/api/config/credentials/openrouter/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!response.ok) await throwDetailedError(response, 'OpenRouter API key validation failed');
    return response.json();
  },

  async getAvailableModels() {
    const response = await fetch(`${API_BASE}/api/models`);
    if (!response.ok) throw new Error('Failed to fetch models');
    return response.json();
  },

  async retryModels(conversationId: string, models: string[], userQuery: string) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/retry`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models, user_query: userQuery }),
      }
    );
    if (!response.ok) throw new Error('Failed to retry models');
    return response.json();
  },

  async rerunAssistant(conversationId: string, payload: unknown) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/rerun`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || 'Failed to rerun assistant stages');
    }
    return response.json();
  },

  async openLogsFolder() {
    throw new Error('Opening logs folder is only available in the native app.');
  },
};

interface TauriFileData {
  filename: string;
  content_type: string | null;
  data: number[];
}

function createTauriTransport(): Transport {
  type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  type ListenFn = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;

  let _invoke: InvokeFn | null = null;
  let _listen: ListenFn | null = null;

  async function getInvoke(): Promise<InvokeFn> {
    if (!_invoke) {
      const mod = await import('@tauri-apps/api/core');
      _invoke = mod.invoke as InvokeFn;
    }
    return _invoke;
  }

  async function getListen(): Promise<ListenFn> {
    if (!_listen) {
      const mod = await import('@tauri-apps/api/event');
      _listen = mod.listen as ListenFn;
    }
    return _listen;
  }

  async function readFilesForTauri(files: File[]): Promise<TauriFileData[]> {
    return Promise.all(
      (files || []).map(async (file) => ({
        filename: file.name,
        content_type: file.type || null,
        data: Array.from(new Uint8Array(await file.arrayBuffer())),
      }))
    );
  }

  return {
    async healthCheck() {
      const invoke = await getInvoke();
      return invoke('health_check');
    },

    async listConversations() {
      const invoke = await getInvoke();
      return invoke('list_conversations');
    },

    async createConversation() {
      const invoke = await getInvoke();
      return invoke('create_conversation');
    },

    async getConversation(conversationId: string) {
      const invoke = await getInvoke();
      return invoke('get_conversation', { conversationId });
    },

    async deleteConversation(conversationId: string) {
      const invoke = await getInvoke();
      try {
        return await invoke('delete_conversation', { conversationId });
      } catch (error: unknown) {
        const message = String((error as Error)?.message || error || '');
        const looksLikeArgMismatch = (
          message.includes('conversation_id')
          || message.includes('missing required key')
          || message.includes('invalid args')
        );
        if (!looksLikeArgMismatch) throw error;
        return invoke('delete_conversation', { conversation_id: conversationId });
      }
    },

    async sendMessage(conversationId: string, content: string, files: File[] = []) {
      const invoke = await getInvoke();
      const fileData = await readFilesForTauri(files);
      return invoke('send_message', { conversationId, content, files: fileData });
    },

    async sendMessageStream(conversationId: string, content: string, files: File[] = [], onEvent: StreamEventCallback) {
      const invoke = await getInvoke();
      const listen = await getListen();

      const fileData = await readFilesForTauri(files);

      const unlisten = await listen<CouncilStreamEvent>('t2ai-event', (tauriEvent) => {
        const event = tauriEvent.payload;
        onEvent(event.type, event);
      });

      try {
        await invoke('send_message_stream', {
          conversationId,
          content,
          files: fileData,
        });
      } finally {
        unlisten();
      }
    },

    async getConfig() {
      const invoke = await getInvoke();
      return invoke('get_config');
    },

    async getStorageInfo() {
      const invoke = await getInvoke();
      return invoke('get_storage_info');
    },

    async updateConfig(config: Partial<AppConfig>) {
      const invoke = await getInvoke();
      return invoke('update_config', { config });
    },

    async setOpenRouterApiKey(apiKey: string) {
      const invoke = await getInvoke();
      return invoke('set_openrouter_api_key', { apiKey });
    },

    async clearOpenRouterApiKey() {
      const invoke = await getInvoke();
      return invoke('clear_openrouter_api_key');
    },

    async testOpenRouterApiKey(apiKey: string = '') {
      const invoke = await getInvoke();
      return invoke('test_openrouter_api_key', { apiKey });
    },

    async openLogsFolder() {
      const invoke = await getInvoke();
      return invoke('open_logs_folder');
    },

    async getAvailableModels() {
      const invoke = await getInvoke();
      return invoke('get_available_models');
    },

    async retryModels(conversationId: string, models: string[], userQuery: string) {
      const invoke = await getInvoke();
      return invoke('retry_models', { conversationId, models, userQuery });
    },

    async rerunAssistant(conversationId: string, payload: unknown) {
      const invoke = await getInvoke();
      return invoke('rerun_assistant', { conversationId, payload });
    },
  };
}

export const runtime: Runtime = detectRuntime();
export const api: Transport = runtime === 'tauri' ? createTauriTransport() : httpTransport;
