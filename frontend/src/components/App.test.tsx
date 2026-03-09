import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CouncilEventType, CouncilStreamEvent } from '@/types/events';

const { mockApi, chatState, settingsState } = vi.hoisted(() => ({
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
  settingsState: {
    latestProps: null as any,
  },
}));

vi.mock('@/lib/transport', () => ({
  api: mockApi,
}));

vi.mock('./Sidebar', () => ({
  default: ({
    conversations,
    currentConversationId,
    onSelectConversation,
    onNewConversation,
    onDeleteConversation,
    onOpenSettings,
    isDarkMode,
    onToggleDarkMode,
  }: any) => (
    <div>
      <div data-testid="sidebar-theme">{isDarkMode ? 'dark' : 'light'}</div>
      <button type="button" onClick={onNewConversation}>new-conversation</button>
      <button type="button" onClick={onToggleDarkMode}>toggle-theme</button>
      <button type="button" onClick={onOpenSettings}>open-settings</button>
      <button
        type="button"
        onClick={() => currentConversationId && onDeleteConversation(currentConversationId)}
        disabled={!currentConversationId}
      >
        delete-current
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
        <button type="button" onClick={() => props.onSendMessage('hello from test', [])}>send-message</button>
        <button type="button" onClick={() => props.onExport()}>export-message</button>
        <button
          type="button"
          onClick={() => props.onRerunAssistant(1, { stage: 'stage3', includeModels: ['model-a'], chairmanModel: 'chair-model' })}
        >
          rerun-assistant
        </button>
        <button type="button" onClick={() => props.onDismissError()}>dismiss-error</button>
        <div data-testid="chat-loading">{String(props.isLoading)}</div>
        <div data-testid="chat-upload-loading">{String(props.isUploadProcessing)}</div>
        <div data-testid="chat-error">{props.error || ''}</div>
        <div data-testid="chat-title">{props.conversation?.title || ''}</div>
        <div data-testid="chat-message-count">{String(props.conversation?.messages?.length ?? -1)}</div>
      </div>
    );
  },
}));

vi.mock('./Settings', () => ({
  default: (props: any) => {
    settingsState.latestProps = props;
    return (
      <div>
        <button
          type="button"
          onClick={() => props.onSaved({ insights_expanded_default: true, theme: 'dark' })}
        >
          save-settings-dark
        </button>
        <button
          type="button"
          onClick={() => props.onSaved({ insights_expanded_default: false, theme: 'system' })}
        >
          save-settings-system
        </button>
        <button type="button" onClick={() => props.onClose()}>close-settings</button>
      </div>
    );
  },
}));

import App from './App';

describe('App', () => {
  beforeEach(() => {
    chatState.latestProps = null;
    settingsState.latestProps = null;
    vi.clearAllMocks();
    localStorage.clear();

    (window as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia = vi.fn()
      .mockImplementation((query: string) => ({ matches: query.includes('dark') }));

    mockApi.healthCheck.mockResolvedValue({});
    mockApi.listConversations.mockResolvedValue([
      {
        id: 'conv-1',
        created_at: '2026-03-06T12:00:00Z',
        title: 'Existing conversation',
        message_count: 3,
      },
    ]);
    mockApi.getConversation.mockImplementation(async (id: string) => ({
      id,
      created_at: '2026-03-06T12:00:00Z',
      title: id === 'conv-2' ? 'Second conversation' : 'Existing conversation',
      messages: [
        {
          role: 'user',
          content: 'Question',
          attachments: [{ id: 'att-1', filename: 'report.pdf', size_bytes: 7, content_type: 'application/pdf' }],
        },
        {
          role: 'assistant',
          stage1: [{ model: 'model-a', response: 'Stage 1 response' }],
          stage2: [{ model: 'model-a', ranking: 'Response A', parsed_ranking: ['Response A'] }],
          stage3: { model: 'chair-model', response: 'Final response' },
          metadata: { aggregate_rankings: [], failed_models: [] },
          timing: { stage1: 1, stage2: 2, stage3: 3 },
          failedModels: [],
          failedModelErrors: {},
        },
      ],
    }));
    mockApi.getConfig.mockResolvedValue({ insights_expanded_default: false });
    mockApi.createConversation.mockResolvedValue({
      id: 'conv-2',
      created_at: '2026-03-06T12:05:00Z',
      title: 'Second conversation',
      messages: [],
    });
    mockApi.deleteConversation.mockResolvedValue({});
    mockApi.sendMessageStream.mockResolvedValue(undefined);
    mockApi.rerunAssistant.mockResolvedValue({
      assistant_message_index: 1,
      assistant_message: {
        role: 'assistant',
        stage3: { model: 'chair-model', response: 'Rerun response' },
      },
    });
  });

  async function renderAndSelectConversation() {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('select-conv-1')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('select-conv-1'));

    await waitFor(() => {
      expect(chatState.latestProps?.conversation?.id).toBe('conv-1');
      expect(chatState.latestProps?.conversation?.messages?.length).toBeGreaterThan(0);
    });
  }

  it('handles new/delete conversation flow and theme toggling', async () => {
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('select-conv-1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('select-conv-1'));
    await waitFor(() => {
      expect(screen.getByText('delete-current')).toBeEnabled();
    });

    fireEvent.click(screen.getByText('toggle-theme'));
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-theme').textContent).toBe('dark');
      expect(localStorage.getItem('t2ai-theme')).toBe('dark');
    });

    fireEvent.click(screen.getByText('new-conversation'));
    await waitFor(() => {
      expect(mockApi.createConversation).toHaveBeenCalledTimes(1);
      expect(mockApi.getConversation).toHaveBeenCalledWith('conv-2');
    });

    fireEvent.click(screen.getByText('delete-current'));
    await waitFor(() => {
      expect(mockApi.deleteConversation).toHaveBeenCalledWith('conv-2');
      expect(mockApi.listConversations).toHaveBeenCalledTimes(2);
    });
  });

  it('applies full stream lifecycle events into state', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    mockApi.sendMessageStream.mockImplementation(async (
      _conversationId: string,
      _content: string,
      _files: File[],
      onEvent: (eventType: CouncilEventType, event: CouncilStreamEvent) => void
    ) => {
      onEvent('upload_processing_start', { type: 'upload_processing_start' });
      onEvent('upload_processing_complete', {
        type: 'upload_processing_complete',
        attachments: [{ id: 'att-processed', filename: 'report.pdf', size_bytes: 9, content_type: 'application/pdf' }],
      });
      onEvent('stage1_start', { type: 'stage1_start' });
      onEvent('stage1_complete', {
        type: 'stage1_complete',
        data: [{ model: 'model-a', response: 'stage1 done' }],
        timing: 1.1,
        failed_models: ['model-b'],
        failed_model_errors: { 'model-b': 'timeout' },
      });
      onEvent('stage2_start', { type: 'stage2_start' });
      onEvent('stage2_complete', {
        type: 'stage2_complete',
        data: [{ model: 'model-a', ranking: 'A', parsed_ranking: ['Response A'] }],
        metadata: { aggregate_rankings: [], failed_models: [] },
        timing: 2.2,
      });
      onEvent('stage3_start', { type: 'stage3_start' });
      onEvent('stage3_complete', {
        type: 'stage3_complete',
        data: { model: 'chair-model', response: 'stage3 done' },
        timing: 3.3,
      });
      onEvent('title_complete', { type: 'title_complete', data: { title: 'New streamed title' } });
      onEvent('complete', {
        type: 'complete',
        metadata: { aggregate_rankings: [], failed_models: [], timing: { stage1: 1.1, stage2: 2.2, stage3: 3.3 } },
      });
      onEvent('unknown_event' as CouncilEventType, { type: 'complete' } as CouncilStreamEvent);
    });

    await renderAndSelectConversation();
    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => {
      const conversation = chatState.latestProps.conversation;
      expect(conversation.messages).toHaveLength(4);
      expect(conversation.title).toBe('New streamed title');
      expect(conversation.messages[2]?.attachments?.[0]?.id).toBe('att-processed');
      expect(conversation.messages[3]?.stage1?.[0]?.response).toBe('stage1 done');
      expect(conversation.messages[3]?.stage2?.[0]?.ranking).toBe('A');
      expect(conversation.messages[3]?.stage3?.response).toBe('stage3 done');
      expect(chatState.latestProps.isUploadProcessing).toBe(false);
      expect(chatState.latestProps.isLoading).toBe(false);
    });

    expect(debugSpy).toHaveBeenCalled();
  });

  it('handles send failures and dismisses errors', async () => {
    mockApi.sendMessageStream.mockRejectedValueOnce(new Error('network down'));
    await renderAndSelectConversation();

    fireEvent.click(screen.getByText('send-message'));

    await waitFor(() => {
      expect(chatState.latestProps.error).toBe('network down');
      expect(chatState.latestProps.isLoading).toBe(false);
    });

    fireEvent.click(screen.getByText('dismiss-error'));
    await waitFor(() => {
      expect(chatState.latestProps.error).toBe(null);
    });
  });

  it('exports markdown with sanitized filename', async () => {
    await renderAndSelectConversation();

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob://export');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fireEvent.click(screen.getByText('export-message'));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    const exported = await blob.text();
    expect(exported).toContain('# Existing conversation');
    expect(exported).toContain('## Stage 3: Final Answer (Chairman: chair-model)');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob://export');
  });

  it('reruns assistant and handles rerun errors', async () => {
    await renderAndSelectConversation();

    fireEvent.click(screen.getByText('rerun-assistant'));
    await waitFor(() => {
      expect(mockApi.rerunAssistant).toHaveBeenCalledWith('conv-1', {
        assistant_message_index: 1,
        stage: 'stage3',
        include_models: ['model-a'],
        chairman_model: 'chair-model',
      });
      expect(chatState.latestProps.conversation.messages[1]?.stage3?.response).toBe('Rerun response');
    });

    mockApi.rerunAssistant.mockRejectedValueOnce(new Error('rerun failed'));
    fireEvent.click(screen.getByText('rerun-assistant'));
    await waitFor(() => {
      expect(chatState.latestProps.error).toBe('rerun failed');
      expect(chatState.latestProps.isLoading).toBe(false);
    });
  });

  it('opens settings and applies saved theme preferences', async () => {
    await renderAndSelectConversation();

    fireEvent.click(screen.getByText('open-settings'));
    await waitFor(() => {
      expect(screen.getByText('save-settings-dark')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('save-settings-dark'));
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-theme').textContent).toBe('dark');
      expect(chatState.latestProps.insightsExpandedDefault).toBe(true);
    });

    fireEvent.click(screen.getByText('open-settings'));
    fireEvent.click(screen.getByText('save-settings-system'));
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-theme').textContent).toBe('dark');
      expect(chatState.latestProps.insightsExpandedDefault).toBe(false);
    });
  });
});
