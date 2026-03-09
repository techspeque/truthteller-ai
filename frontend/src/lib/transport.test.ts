import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './transport';

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
});
