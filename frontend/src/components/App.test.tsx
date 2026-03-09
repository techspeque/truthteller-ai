import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CouncilEventType, CouncilStreamEvent } from '@/types/events';

const { mockApi, chatState } = vi.hoisted(() => ({
  mockApi: {
    healthCheck: vi.fn(),
    listConversations: vi.fn(),
    getConfig: vi.fn(),
    getConversation: vi.fn(),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    sendMessageStream: vi.fn(),
    rerunAssistant: vi.fn(),
  },
  chatState: {
    latestProps: null as any,
  },
}));

vi.mock('@/lib/transport', () => ({
  api: mockApi,
}));

vi.mock('./Sidebar', () => ({
  default: ({ conversations, onSelectConversation, onNewConversation }: any) => (
    <div>
      <button type="button" onClick={onNewConversation}>
        new-conversation
      </button>
      {conversations.map((conversation: any) => (
        <button
          key={conversation.id}
          type="button"
          onClick={() => onSelectConversation(conversation.id)}
        >
          {`select-${conversation.id}`}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('./ChatInterface', () => ({
  default: (props: any) => {
    chatState.latestProps = props;
    return (
      <div>
        <button
          type="button"
          onClick={() => props.onSendMessage('hello from test', [])}
        >
          send-message
        </button>
        <div data-testid="chat-loading">{String(props.isLoading)}</div>
        <div data-testid="chat-error">{props.error || ''}</div>
        <div data-testid="chat-message-count">{String(props.conversation?.messages?.length ?? -1)}</div>
      </div>
    );
  },
}));

vi.mock('./Settings', () => ({
  default: () => <div>settings</div>,
}));

import App from './App';

describe('App streaming flow', () => {
  beforeEach(() => {
    chatState.latestProps = null;
    vi.clearAllMocks();

    mockApi.healthCheck.mockResolvedValue({});
    mockApi.listConversations.mockResolvedValue([
      {
        id: 'conv-1',
        created_at: '2026-03-06T12:00:00Z',
        title: 'Existing conversation',
        message_count: 0,
      },
    ]);
    mockApi.getConversation.mockResolvedValue({
      id: 'conv-1',
      created_at: '2026-03-06T12:00:00Z',
      title: 'Existing conversation',
      messages: [],
    });
    mockApi.getConfig.mockResolvedValue({ insights_expanded_default: false });
    mockApi.createConversation.mockResolvedValue({
      id: 'conv-1',
      created_at: '2026-03-06T12:00:00Z',
      title: 'Existing conversation',
      messages: [],
    });
    mockApi.deleteConversation.mockResolvedValue({});
    mockApi.rerunAssistant.mockResolvedValue({
      assistant_message_index: 0,
      assistant_message: { role: 'assistant' },
    });
  });

  async function selectConversation() {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('select-conv-1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('select-conv-1'));

    await waitFor(() => {
      expect(chatState.latestProps?.conversation?.id).toBe('conv-1');
    });
  }

  it('applies stage events into the optimistic assistant message', async () => {
    mockApi.sendMessageStream.mockImplementation(async (
      _conversationId: string,
      _content: string,
      _files: File[],
      onEvent: (eventType: CouncilEventType, event: CouncilStreamEvent) => void
    ) => {
      onEvent('stage1_start', { type: 'stage1_start' });
      onEvent('stage1_complete', {
        type: 'stage1_complete',
        data: [{ model: 'model-a', response: 'stage 1 answer' }],
        timing: 1.2,
        failed_models: [],
        failed_model_errors: {},
      });
      onEvent('complete', {
        type: 'complete',
        metadata: {
          aggregate_rankings: [],
          failed_models: [],
          timing: { stage1: 1.2 },
        },
      });
    });

    await selectConversation();
    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => {
      expect(mockApi.sendMessageStream).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      const conversation = chatState.latestProps.conversation;
      expect(conversation.messages).toHaveLength(2);
      expect(conversation.messages[0]?.role).toBe('user');
      expect(conversation.messages[1]?.role).toBe('assistant');
      expect(conversation.messages[1]?.stage1?.[0]?.model).toBe('model-a');
      expect(chatState.latestProps.isLoading).toBe(false);
    });
  });

  it('rolls back optimistic messages on early stream error', async () => {
    mockApi.sendMessageStream.mockImplementation(async (
      _conversationId: string,
      _content: string,
      _files: File[],
      onEvent: (eventType: CouncilEventType, event: CouncilStreamEvent) => void
    ) => {
      onEvent('error', { type: 'error', message: 'stream exploded' });
    });

    await selectConversation();
    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => {
      expect(chatState.latestProps.error).toBe('stream exploded');
      expect(chatState.latestProps.isLoading).toBe(false);
      expect(chatState.latestProps.conversation.messages).toHaveLength(0);
    });
  });
});
