/**
 * Dual transport abstraction for TruthTeller AI.
 * Auto-detects Tauri vs web runtime and exports the appropriate API client.
 */

import { log } from '@/lib/logger';

const API_BASE = 'http://localhost:8001';

/**
 * Detect whether we're running inside Tauri or a regular browser.
 */
function detectRuntime() {
  if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
    return 'tauri';
  }
  return 'web';
}

function buildMessageRequestOptions(content, files = []) {
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

async function throwDetailedError(response, fallback) {
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

/**
 * HTTP transport — used in web mode, talks to the axum/FastAPI backend.
 */
const httpTransport = {
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

  async getConversation(conversationId) {
    const response = await fetch(`${API_BASE}/api/conversations/${conversationId}`);
    if (!response.ok) throw new Error('Failed to get conversation');
    return response.json();
  },

  async deleteConversation(conversationId) {
    const response = await fetch(`${API_BASE}/api/conversations/${conversationId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete conversation');
    return response.json();
  },

  async sendMessage(conversationId, content, files = []) {
    const hasFiles = files && files.length > 0;
    const url = hasFiles
      ? `${API_BASE}/api/conversations/${conversationId}/message/upload`
      : `${API_BASE}/api/conversations/${conversationId}/message`;
    const response = await fetch(url, buildMessageRequestOptions(content, files));
    if (!response.ok) throw new Error('Failed to send message');
    return response.json();
  },

  async sendMessageStream(conversationId, content, files = [], onEvent) {
    const response = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/message/stream`,
      buildMessageRequestOptions(content, files)
    );
    if (!response.ok) throw new Error('Failed to send message');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const event = JSON.parse(data);
            onEvent(event.type, event);
          } catch (e) {
            log.warn('Failed to parse SSE event', { error: e.message, data });
          }
        }
      }
    }
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

  async updateConfig(config) {
    const response = await fetch(`${API_BASE}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!response.ok) await throwDetailedError(response, 'Failed to update config');
    return response.json();
  },

  async setOpenRouterApiKey(apiKey) {
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

  async testOpenRouterApiKey(apiKey = '') {
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

  async retryModels(conversationId, models, userQuery) {
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

  async rerunAssistant(conversationId, payload) {
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

/**
 * Tauri transport — calls Rust commands via IPC.
 * Uses @tauri-apps/api invoke() for CRUD and listen() for streaming events.
 */
function createTauriTransport() {
  // Lazy-load Tauri APIs so the module doesn't break in non-Tauri contexts.
  let _invoke = null;
  let _listen = null;

  async function getInvoke() {
    if (!_invoke) {
      const mod = await import('@tauri-apps/api/core');
      _invoke = mod.invoke;
    }
    return _invoke;
  }

  async function getListen() {
    if (!_listen) {
      const mod = await import('@tauri-apps/api/event');
      _listen = mod.listen;
    }
    return _listen;
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

    async getConversation(conversationId) {
      const invoke = await getInvoke();
      return invoke('get_conversation', { conversationId });
    },

    async deleteConversation(conversationId) {
      const invoke = await getInvoke();
      try {
        return await invoke('delete_conversation', { conversationId });
      } catch (error) {
        const message = String(error?.message || error || '');
        const looksLikeArgMismatch = (
          message.includes('conversation_id')
          || message.includes('missing required key')
          || message.includes('invalid args')
        );
        if (!looksLikeArgMismatch) throw error;
        return invoke('delete_conversation', { conversation_id: conversationId });
      }
    },

    async sendMessage(conversationId, content, files = []) {
      const invoke = await getInvoke();
      // For file uploads in Tauri, read files as ArrayBuffers and pass as binary
      const fileData = await Promise.all(
        (files || []).map(async (file) => ({
          filename: file.name,
          content_type: file.type || null,
          data: Array.from(new Uint8Array(await file.arrayBuffer())),
        }))
      );
      return invoke('send_message', { conversationId, content, files: fileData });
    },

    async sendMessageStream(conversationId, content, files = [], onEvent) {
      const invoke = await getInvoke();
      const listen = await getListen();

      // Read files before starting the stream
      const fileData = await Promise.all(
        (files || []).map(async (file) => ({
          filename: file.name,
          content_type: file.type || null,
          data: Array.from(new Uint8Array(await file.arrayBuffer())),
        }))
      );

      // Listen for streaming events from Rust
      const unlisten = await listen('t2ai-event', (tauriEvent) => {
        const event = tauriEvent.payload;
        onEvent(event.type, event);
      });

      try {
        // This invoke completes when the full council process is done.
        // Events are emitted along the way via the 't2ai-event' channel.
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

    async updateConfig(config) {
      const invoke = await getInvoke();
      return invoke('update_config', { config });
    },

    async setOpenRouterApiKey(apiKey) {
      const invoke = await getInvoke();
      return invoke('set_openrouter_api_key', { apiKey });
    },

    async clearOpenRouterApiKey() {
      const invoke = await getInvoke();
      return invoke('clear_openrouter_api_key');
    },

    async testOpenRouterApiKey(apiKey = '') {
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

    async retryModels(conversationId, models, userQuery) {
      const invoke = await getInvoke();
      return invoke('retry_models', { conversationId, models, userQuery });
    },

    async rerunAssistant(conversationId, payload) {
      const invoke = await getInvoke();
      return invoke('rerun_assistant', { conversationId, payload });
    },
  };
}

/**
 * Auto-selected API client based on detected runtime.
 */
export const runtime = detectRuntime();
export const api = runtime === 'tauri' ? createTauriTransport() : httpTransport;
