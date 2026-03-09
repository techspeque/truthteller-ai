import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './transport';

function createJsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: vi.fn().mockResolvedValue(data),
    text: vi.fn().mockResolvedValue(typeof data === 'string' ? data : JSON.stringify(data)),
  } as unknown as Response;
}

function createDetailedErrorResponse(opts: { detail?: string; message?: string; text?: string } = {}): Response {
  const { detail, message, text = '' } = opts;
  return {
    ok: false,
    json: vi.fn().mockResolvedValue({ detail, message }),
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

function createTextOnlyErrorResponse(text: string): Response {
  return {
    ok: false,
    json: vi.fn().mockRejectedValue(new Error('not-json')),
    text: vi.fn().mockResolvedValue(text),
  } as unknown as Response;
}

function createStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('http transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls conversation CRUD endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ ok: true }))
      .mockResolvedValueOnce(createJsonResponse([{ id: 'conv-1' }]))
      .mockResolvedValueOnce(createJsonResponse({ id: 'conv-2' }))
      .mockResolvedValueOnce(createJsonResponse({ id: 'conv-1', messages: [] }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.healthCheck()).resolves.toEqual({ ok: true });
    await expect(api.listConversations()).resolves.toEqual([{ id: 'conv-1' }]);
    await expect(api.createConversation()).resolves.toEqual({ id: 'conv-2' });
    await expect(api.getConversation('conv-1')).resolves.toEqual({ id: 'conv-1', messages: [] });
    await expect(api.deleteConversation('conv-1')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:8001/');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:8001/api/conversations');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:8001/api/conversations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(4, 'http://localhost:8001/api/conversations/conv-1');
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'http://localhost:8001/api/conversations/conv-1',
      { method: 'DELETE' }
    );
  });

  it('sendMessage uses JSON endpoint when there are no files', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.sendMessage('conv-1', 'hello')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8001/api/conversations/conv-1/message',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' }),
      }
    );
  });

  it('sendMessage uses multipart upload endpoint when files are provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });

    await expect(api.sendMessage('conv-1', 'hello', [file])).resolves.toEqual({ ok: true });

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('http://localhost:8001/api/conversations/conv-1/message/upload');
    const options = call?.[1] as RequestInit;
    expect(options.method).toBe('POST');
    expect(options.body instanceof FormData).toBe(true);
  });

  it('handles config and credential endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse({ theme: 'light' }))
      .mockResolvedValueOnce(createJsonResponse({ runtime: 'web' }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getConfig()).resolves.toEqual({ theme: 'light' });
    await expect(api.getStorageInfo()).resolves.toEqual({ runtime: 'web' });
    await expect(api.updateConfig({ theme: 'dark' })).resolves.toEqual({ ok: true });
    await expect(api.setOpenRouterApiKey('sk-or-12345678901234')).resolves.toEqual({ ok: true });
    await expect(api.clearOpenRouterApiKey()).resolves.toEqual({ ok: true });
    await expect(api.testOpenRouterApiKey('sk-or-12345678901234')).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:8001/api/config');
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'http://localhost:8001/api/storage/info');
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:8001/api/config',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: 'dark' }),
      }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://localhost:8001/api/config/credentials/openrouter',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'sk-or-12345678901234' }),
      }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      'http://localhost:8001/api/config/credentials/openrouter',
      { method: 'DELETE' }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      'http://localhost:8001/api/config/credentials/openrouter/test',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'sk-or-12345678901234' }),
      }
    );
  });

  it('handles models/retry/rerun endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse([{ id: 'm1' }]))
      .mockResolvedValueOnce(createJsonResponse({ ok: true }))
      .mockResolvedValueOnce(createJsonResponse({ assistant_message_index: 1, assistant_message: { role: 'assistant' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.getAvailableModels()).resolves.toEqual([{ id: 'm1' }]);
    await expect(api.retryModels('conv-1', ['m1'], 'q')).resolves.toEqual({ ok: true });
    await expect(api.rerunAssistant('conv-1', { assistant_message_index: 1 })).resolves.toEqual({
      assistant_message_index: 1,
      assistant_message: { role: 'assistant' },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:8001/api/models');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8001/api/conversations/conv-1/retry',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: ['m1'], user_query: 'q' }),
      }
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:8001/api/conversations/conv-1/rerun',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assistant_message_index: 1 }),
      }
    );
  });

  it('uses detailed backend errors from JSON and text responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(createDetailedErrorResponse({ detail: 'bad config' })));
    await expect(api.updateConfig({ theme: 'invalid' })).rejects.toThrow('bad config');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(createDetailedErrorResponse({ message: 'invalid key' })));
    await expect(api.setOpenRouterApiKey('bad')).rejects.toThrow('invalid key');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(createTextOnlyErrorResponse('plain-text failure')));
    await expect(api.clearOpenRouterApiKey()).rejects.toThrow('plain-text failure');
  });

  it('uses fallback errors for non-detailed endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createJsonResponse({ error: true }, false)));

    await expect(api.healthCheck()).rejects.toThrow('Backend unavailable');
    await expect(api.listConversations()).rejects.toThrow('Failed to list conversations');
    await expect(api.createConversation()).rejects.toThrow('Failed to create conversation');
    await expect(api.getConversation('conv-1')).rejects.toThrow('Failed to get conversation');
    await expect(api.deleteConversation('conv-1')).rejects.toThrow('Failed to delete conversation');
    await expect(api.sendMessage('conv-1', 'test')).rejects.toThrow('Failed to send message');
    await expect(api.getConfig()).rejects.toThrow('Failed to get config');
    await expect(api.getStorageInfo()).rejects.toThrow('Failed to get storage info');
    await expect(api.getAvailableModels()).rejects.toThrow('Failed to fetch models');
    await expect(api.retryModels('conv-1', ['m1'], 'q')).rejects.toThrow('Failed to retry models');
    await expect(api.testOpenRouterApiKey()).rejects.toThrow('OpenRouter API key validation failed');
  });

  it('uses rerun fallback error when backend returns empty text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      text: vi.fn().mockResolvedValue(''),
    } as unknown as Response));

    await expect(api.rerunAssistant('conv-1', { assistant_message_index: 0 })).rejects.toThrow(
      'Failed to rerun assistant stages'
    );
  });

  it('openLogsFolder throws in web runtime', async () => {
    await expect(api.openLogsFolder()).rejects.toThrow('Opening logs folder is only available in the native app.');
  });
});

describe('http transport stream parsing', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses events split across chunk boundaries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createStreamResponse([
      'data: {"type":"stage1_com',
      'plete","data":[]}\n',
      'data: {"type":"complete","metadata":{"aggregate_rankings":[],"failed_models":[]}}\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const received: string[] = [];
    await api.sendMessageStream('conv-1', 'hello', [], (eventType) => {
      received.push(eventType);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(received).toEqual(['stage1_complete', 'complete']);
  });

  it('logs invalid JSON lines and continues parsing later events', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(createStreamResponse([
      'data: not-json\n',
      'data: {"type":"error","message":"boom"}\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const received: string[] = [];
    await api.sendMessageStream('conv-1', 'hello', [], (eventType) => {
      received.push(eventType);
    });

    expect(received).toEqual(['error']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('throws when stream response body is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: null,
    } as unknown as Response));

    await expect(api.sendMessageStream('conv-1', 'hello', [], vi.fn())).rejects.toThrow('Missing response body');
  });
});
