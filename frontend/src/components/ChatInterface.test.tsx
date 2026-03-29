import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@/types/api';

vi.mock('./Stage1', () => ({
  default: ({ responses }: any) => <div data-testid="stage1-panel">{responses?.length || 0}</div>,
}));

vi.mock('./Stage2', () => ({
  default: ({ rankings }: any) => <div data-testid="stage2-panel">{rankings?.length || 0}</div>,
}));

vi.mock('./Stage3', () => ({
  default: ({ finalResponse }: any) => <div data-testid="stage3-panel">{finalResponse?.response}</div>,
}));

vi.mock('./CouncilInsights', () => ({
  default: ({ assistantIndex, onRerunAssistant }: any) => (
    <div>
      <span data-testid="insights-panel">{`insights-${assistantIndex}`}</span>
      <button type="button" onClick={() => onRerunAssistant(assistantIndex, { stage: 'stage2' })}>
        rerun-from-insights
      </button>
    </div>
  ),
}));

import ChatInterface from './ChatInterface';

function baseConversation(messages: Conversation['messages'] = []): Conversation {
  return {
    id: 'conv-1',
    created_at: '2026-03-09T12:00:00Z',
    title: 'Conversation title',
    messages,
  };
}

describe('ChatInterface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
  });

  it('shows welcome state when no conversation and backend is down', () => {
    render(
      <ChatInterface
        conversation={null}
        onSendMessage={vi.fn()}
        isLoading={false}
        isUploadProcessing={false}
        error={null}
        onDismissError={vi.fn()}
        backendOk={false}
        onExport={vi.fn()}
        onRerunAssistant={vi.fn()}
      />
    );

    expect(screen.getByText(/Backend unavailable/i)).toBeInTheDocument();
    expect(screen.getByText('Welcome to TruthTeller AI')).toBeInTheDocument();
  });

  it('sends text and attached files, dedupes across selections, and clears composer', async () => {
    const onSendMessage = vi.fn();
    const { container } = render(
      <ChatInterface
        conversation={baseConversation([])}
        onSendMessage={onSendMessage}
        isLoading={false}
        isUploadProcessing={false}
        error={null}
        onDismissError={vi.fn()}
        backendOk={true}
        onExport={vi.fn()}
        onRerunAssistant={vi.fn()}
      />
    );

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const textarea = screen.getByPlaceholderText('Ask your question... (or upload files and send)') as HTMLTextAreaElement;

    const file1 = new File(['a'], 'a.txt', { type: 'text/plain' });
    const file1Dup = new File(['a'], 'a.txt', { type: 'text/plain' });
    const file2 = new File(['bbbb'], 'b.md', { type: 'text/markdown' });

    fireEvent.change(fileInput, { target: { files: [file1] } });
    fireEvent.change(fileInput, { target: { files: [file1Dup, file2] } });
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);

    fireEvent.change(textarea, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(onSendMessage.mock.calls[0]?.[0]).toBe('hello world');
    expect((onSendMessage.mock.calls[0]?.[1] as File[]).map((f) => f.name)).toEqual(['a.txt', 'b.md']);

    await waitFor(() => {
      expect(textarea.value).toBe('');
      expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    });
  });

  it('renders message content, stages, indicators, and insights interactions', () => {
    const onDismissError = vi.fn();
    const onExport = vi.fn();
    const onRerunAssistant = vi.fn();

    render(
      <ChatInterface
        conversation={baseConversation([
          {
            role: 'user',
            content: '',
            attachments: [
              { id: 'f1', filename: 'tiny.txt', size_bytes: 500, content_type: 'text/plain' },
              { id: 'f2', filename: 'medium.txt', size_bytes: 2048, content_type: 'text/plain' },
              { id: 'f3', filename: 'large.bin', size_bytes: 2 * 1024 * 1024, content_type: 'application/octet-stream' },
            ],
          },
          {
            role: 'assistant',
            stage1: [{ model: 'provider/m1', response: 'r1' }],
            stage2: [{ model: 'provider/m2', ranking: 'rank', parsed_ranking: [] }],
            stage3: { model: 'provider/chair', response: 'final text' },
            metadata: { aggregate_rankings: [], failed_models: [], timing: { stage1: 1, stage2: 2, stage3: 3 } },
            loading: { stage1: true, stage2: true, stage3: true },
          },
        ])}
        onSendMessage={vi.fn()}
        isLoading={true}
        isUploadProcessing={true}
        error="boom"
        onDismissError={onDismissError}
        backendOk={false}
        onExport={onExport}
        onRerunAssistant={onRerunAssistant}
      />
    );

    expect(screen.getByText('Files-only request')).toBeInTheDocument();
    expect(screen.getByText('500 B')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('2.0 MB')).toBeInTheDocument();
    expect(screen.getByText('S1: 1s')).toBeInTheDocument();
    expect(screen.getByText('S2: 2s')).toBeInTheDocument();
    expect(screen.getByText('S3: 3s')).toBeInTheDocument();
    expect(screen.getByTestId('stage1-panel')).toBeInTheDocument();
    expect(screen.getByTestId('stage2-panel')).toBeInTheDocument();
    expect(screen.getByTestId('stage3-panel')).toBeInTheDocument();
    expect(screen.getByText('Processing attachments...')).toBeInTheDocument();
    expect(screen.getByText('Consulting the council...')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissError).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /Council Insights/ }));
    expect(screen.getByTestId('insights-panel')).toHaveTextContent('insights-1');
    fireEvent.click(screen.getByRole('button', { name: 'rerun-from-insights' }));
    expect(onRerunAssistant).toHaveBeenCalledWith(1, { stage: 'stage2' });

    const textarea = screen.getByPlaceholderText('Ask your question... (or upload files and send)');
    expect(textarea).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

});
