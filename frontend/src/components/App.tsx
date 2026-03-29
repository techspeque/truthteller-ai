import { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import ChatInterface from './ChatInterface';
import Settings from './Settings';
import { api } from '@/lib/transport';
import { log } from '@/lib/logger';
import type {
  Conversation,
  ConversationSummary,
  AssistantMessage,
  UserMessage,
  AppConfigResponse,
} from '@/types/api';
import type { CouncilStreamEvent, CouncilEventType } from '@/types/events';
import './App.css';

type Theme = 'dark' | 'light';

function App() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [currentConversation, setCurrentConversation] = useState<Conversation | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploadProcessing, setIsUploadProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = localStorage.getItem('t2ai-theme');
    return stored === 'dark' ? 'dark' : 'light';
  });

  const loadConversations = async () => {
    try {
      const convs = await api.listConversations();
      setConversations(convs);
    } catch (err) {
      log.error('Failed to load conversations', { error: (err as Error).message });
    }
  };

  useEffect(() => {
    api.healthCheck()
      .then(() => setBackendOk(true))
      .catch((err: Error) => {
        log.warn('Backend health check failed', { error: err.message });
        setBackendOk(false);
      });

    api.listConversations()
      .then((convs) => setConversations(convs))
      .catch((err: Error) => log.error('Failed to load conversations', { error: err.message }));

  }, []);

  useEffect(() => {
    localStorage.setItem('t2ai-theme', theme);
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.body.classList.toggle('theme-light', theme === 'light');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => () => {
    document.body.classList.remove('theme-dark', 'theme-light');
    document.documentElement.style.colorScheme = '';
  }, []);

  useEffect(() => {
    if (currentConversationId) {
      api.getConversation(currentConversationId)
        .then((conv) => setCurrentConversation(conv))
        .catch((err: Error) => log.error('Failed to load conversation', { conversationId: currentConversationId, error: err.message }));
    }
  }, [currentConversationId]);

  const handleNewConversation = async () => {
    try {
      const newConv = await api.createConversation();
      setConversations([
        { id: newConv.id, created_at: newConv.created_at, title: newConv.title || '', message_count: 0 },
        ...conversations,
      ]);
      setCurrentConversationId(newConv.id);
    } catch (err) {
      log.error('Failed to create conversation', { error: (err as Error).message });
      setError('Failed to create conversation');
    }
  };

  const handleSelectConversation = (id: string) => {
    setCurrentConversationId(id);
  };

  const handleDeleteConversation = async (id: string) => {
    setError(null);
    try {
      await api.deleteConversation(id);
      log.info('Deleted conversation', { conversationId: id });
      await loadConversations();
      if (currentConversationId === id) {
        setCurrentConversationId(null);
        setCurrentConversation(null);
      }
    } catch (err) {
      log.error('Failed to delete conversation', { conversationId: id, error: (err as Error).message });
      setError((err as Error).message || 'Failed to delete conversation');
    }
  };

  const handleSendMessage = async (content: string, files: File[] = []) => {
    if (!currentConversationId) return;

    log.info('Sending message', { conversationId: currentConversationId, fileCount: files?.length || 0 });
    setIsLoading(true);
    setIsUploadProcessing(false);
    setError(null);
    try {
      const optimisticAttachments = (files || []).map((file) => ({
        id: `local-${file.name}-${file.size}`,
        filename: file.name,
        size_bytes: file.size,
        content_type: file.type || null,
      }));

      const userMessage: UserMessage = { role: 'user', content, attachments: optimisticAttachments };
      setCurrentConversation((prev) => {
        if (!prev) return prev;
        return { ...prev, messages: [...prev.messages, userMessage] };
      });

      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        stage1: null,
        stage2: null,
        stage3: null,
        metadata: null,
        timing: {},
        failedModels: [],
        loading: {
          stage1: false,
          stage2: false,
          stage3: false,
        },
      };

      setCurrentConversation((prev) => {
        if (!prev) return prev;
        return { ...prev, messages: [...prev.messages, assistantMessage] };
      });

      await api.sendMessageStream(currentConversationId, content, files, (eventType: CouncilEventType, event: CouncilStreamEvent) => {
        switch (eventType) {
          case 'upload_processing_start':
            setIsUploadProcessing(true);
            break;

          case 'upload_processing_complete':
            setIsUploadProcessing(false);
            setCurrentConversation((prev) => {
              if (!prev) return prev;
              const messages = [...prev.messages];
              if (messages.length < 2) return prev;
              const userIndex = messages.length - 2;
              const userMsg = messages[userIndex];
              if (!userMsg || userMsg.role !== 'user') return prev;
              messages[userIndex] = {
                ...userMsg,
                attachments: (event.type === 'upload_processing_complete' && event.attachments) ? event.attachments : userMsg.attachments,
              };
              return { ...prev, messages };
            });
            break;

          case 'stage1_start':
            setIsUploadProcessing(false);
            setCurrentConversation((prev) => {
              if (!prev) return prev;
              const messages = [...prev.messages];
              const lastMsg = messages[messages.length - 1];
              if (!lastMsg || lastMsg.role !== 'assistant') return prev;
              const models = (event.type === 'stage1_start' && event.models) || [];
              messages[messages.length - 1] = {
                ...lastMsg,
                loading: { ...lastMsg.loading!, stage1: true },
                modelStatuses: models.map((m) => ({ model: m, status: 'waiting' as const })),
              };
              return { ...prev, messages };
            });
            break;

          case 'stage1_complete':
            setCurrentConversation((prev) => {
              if (!prev) return prev;
              const messages = [...prev.messages];
              const lastMsg = messages[messages.length - 1];
              if (!lastMsg || lastMsg.role !== 'assistant') return prev;
              if (event.type !== 'stage1_complete') return prev;
              const succeeded = new Set((event.data || []).map((r) => r.model));
              const failedErrors = event.failed_model_errors || {};
              const statuses = (lastMsg.modelStatuses || []).map((entry) => {
                if (succeeded.has(entry.model)) return { ...entry, status: 'success' as const };
                if ((event.failed_models || []).includes(entry.model)) return { ...entry, status: 'failed' as const, error: failedErrors[entry.model] };
                return { ...entry, status: 'success' as const };
              });
              messages[messages.length - 1] = {
                ...lastMsg,
                stage1: event.data,
                loading: { ...lastMsg.loading!, stage1: false },
                timing: { ...lastMsg.timing, stage1: event.timing },
                failedModels: event.failed_models || [],
                failedModelErrors: event.failed_model_errors || {},
                modelStatuses: statuses,
              };
              return { ...prev, messages };
            });
            break;

          case 'stage2_start':
            setCurrentConversation((prev) => {
              if (!prev) return prev;
              const messages = [...prev.messages];
              const lastMsg = messages[messages.length - 1];
              if (!lastMsg || lastMsg.role !== 'assistant') return prev;
              const models = (event.type === 'stage2_start' && event.models) || [];
              messages[messages.length - 1] = {
                ...lastMsg,
                loading: { ...lastMsg.loading!, stage2: true },
                modelStatuses: models.map((m) => ({ model: m, status: 'waiting' as const })),
              };
              return { ...prev, messages };
            });
            break;

          case 'stage2_complete':
            setCurrentConversation((prev) => {
              if (!prev) return prev;
              const messages = [...prev.messages];
              const lastMsg = messages[messages.length - 1];
              if (!lastMsg || lastMsg.role !== 'assistant') return prev;
              if (event.type !== 'stage2_complete') return prev;
              const succeeded = new Set((event.data || []).map((r) => r.model));
              const statuses = (lastMsg.modelStatuses || []).map((entry) =>
                succeeded.has(entry.model)
                  ? { ...entry, status: 'success' as const }
                  : { ...entry, status: 'failed' as const }
              );
              messages[messages.length - 1] = {
                ...lastMsg,
                stage2: event.data,
                metadata: event.metadata || null,
                loading: { ...lastMsg.loading!, stage2: false },
                timing: { ...lastMsg.timing, stage2: event.timing },
                modelStatuses: statuses,
              };
              return { ...prev, messages };
            });
            break;

          case 'stage3_start':
            setCurrentConversation((prev) => {
              if (!prev) return prev;
              const messages = [...prev.messages];
              const lastMsg = messages[messages.length - 1];
              if (!lastMsg || lastMsg.role !== 'assistant') return prev;
              const models = (event.type === 'stage3_start' && event.models) || [];
              messages[messages.length - 1] = {
                ...lastMsg,
                loading: { ...lastMsg.loading!, stage3: true },
                modelStatuses: models.map((m) => ({ model: m, status: 'waiting' as const })),
              };
              return { ...prev, messages };
            });
            break;

          case 'stage3_complete':
            setCurrentConversation((prev) => {
              if (!prev) return prev;
              const messages = [...prev.messages];
              const lastMsg = messages[messages.length - 1];
              if (!lastMsg || lastMsg.role !== 'assistant') return prev;
              if (event.type !== 'stage3_complete') return prev;
              messages[messages.length - 1] = {
                ...lastMsg,
                stage3: event.data,
                loading: { ...lastMsg.loading!, stage3: false },
                timing: { ...lastMsg.timing, stage3: event.timing },
                modelStatuses: (lastMsg.modelStatuses || []).map((entry) => ({ ...entry, status: 'success' as const })),
              };
              return { ...prev, messages };
            });
            break;

          case 'title_complete':
            loadConversations();
            setCurrentConversation((prev) => {
              if (prev?.id !== currentConversationId) return prev;
              if (!prev || event.type !== 'title_complete') return prev;
              return { ...prev, title: event.data.title };
            });
            break;

          case 'complete':
            loadConversations();
            setIsUploadProcessing(false);
            setCurrentConversation((prev) => {
              if (!prev?.messages?.length) return prev;
              const messages = [...prev.messages];
              const lastMsg = messages[messages.length - 1];
              if (!lastMsg || lastMsg.role !== 'assistant') return prev;
              if (event.type !== 'complete') return prev;
              if (event.metadata) {
                const updated = { ...lastMsg, metadata: event.metadata };
                if (event.metadata.timing) {
                  updated.timing = { ...lastMsg.timing, ...event.metadata.timing };
                }
                messages[messages.length - 1] = updated;
              }
              return { ...prev, messages };
            });
            setIsLoading(false);
            break;

          case 'error':
            setIsUploadProcessing(false);
            setError(event.type === 'error' ? event.message : 'An error occurred during council deliberation');
            setCurrentConversation((prev) => {
              if (!prev) return prev;
              const messages = [...prev.messages];
              if (messages.length < 2) return prev;
              const lastMsg = messages[messages.length - 1];
              const prevMsg = messages[messages.length - 2];
              const isEarlyFailure = (
                lastMsg?.role === 'assistant' &&
                !lastMsg.stage1 &&
                !lastMsg.stage2 &&
                !lastMsg.stage3 &&
                prevMsg?.role === 'user'
              );
              if (!isEarlyFailure) return prev;
              return { ...prev, messages: messages.slice(0, -2) };
            });
            setIsLoading(false);
            break;

          default:
            log.debug('Unknown event type', { eventType });
        }
      });
    } catch (err) {
      log.error('Message send failed', { conversationId: currentConversationId, error: (err as Error).message });
      setIsUploadProcessing(false);
      setError((err as Error).message || 'Failed to send message');
      setCurrentConversation((prev) => {
        if (!prev) return prev;
        return { ...prev, messages: prev.messages.slice(0, -2) };
      });
      setIsLoading(false);
    }
  };

  const handleExportMarkdown = () => {
    if (!currentConversation || currentConversation.messages.length === 0) return;

    let md = `# ${currentConversation.title || 'TruthTeller AI Conversation'}\n\n`;

    for (const msg of currentConversation.messages) {
      if (msg.role === 'user') {
        md += `## Question\n${msg.content}\n\n`;
        if (msg.attachments && msg.attachments.length > 0) {
          md += '### Attachments\n';
          for (const attachment of msg.attachments) {
            md += `- ${attachment.filename}\n`;
          }
          md += '\n';
        }
      } else if (msg.role === 'assistant') {
        if (msg.stage1) {
          md += `## Stage 1: Individual Responses\n`;
          for (const r of msg.stage1) {
            md += `### ${r.model}\n${r.response}\n\n`;
          }
        }
        if (msg.stage2) {
          md += `## Stage 2: Peer Rankings\n`;
          for (const r of msg.stage2) {
            md += `### ${r.model}'s Evaluation\n${r.ranking}\n\n`;
          }
        }
        if (msg.stage3) {
          md += `## Stage 3: Final Answer (Chairman: ${msg.stage3.model})\n${msg.stage3.response}\n\n`;
        }
        md += '---\n\n';
      }
    }

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(currentConversation.title || 'conversation').replace(/[^a-z0-9]/gi, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRerunAssistant = async (assistantIndex: number, options: { stage?: string; includeModels?: string[]; chairmanModel?: string | null }) => {
    if (!currentConversationId) return;
    log.info('Rerunning assistant stages', { conversationId: currentConversationId, assistantIndex, stage: options.stage || 'stage2' });
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.rerunAssistant(currentConversationId, {
        assistant_message_index: assistantIndex,
        stage: options.stage || 'stage2',
        include_models: options.includeModels,
        chairman_model: options.chairmanModel || null,
      });
      const updatedMessage = response.assistant_message;
      const updatedIndex = response.assistant_message_index;
      setCurrentConversation((prev) => {
        if (!prev?.messages?.length) return prev;
        const messages = [...prev.messages];
        messages[updatedIndex] = updatedMessage;
        return { ...prev, messages };
      });
    } catch (err) {
      log.error('Rerun failed', { conversationId: currentConversationId, error: (err as Error).message });
      setError((err as Error).message || 'Failed to re-run council stages');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const handleSettingsSaved = (updatedConfig: AppConfigResponse) => {
    const nextTheme = updatedConfig?.theme;
    if (nextTheme === 'dark' || nextTheme === 'light') {
      setTheme(nextTheme);
      return;
    }
    if (nextTheme === 'system' && typeof window !== 'undefined') {
      const systemDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      setTheme(systemDark ? 'dark' : 'light');
    }
  };

  return (
    <div className={`app ${theme === 'dark' ? 'theme-dark' : 'theme-light'}`}>
      <Sidebar
        conversations={conversations}
        currentConversationId={currentConversationId}
        onSelectConversation={handleSelectConversation}
        onNewConversation={handleNewConversation}
        onDeleteConversation={handleDeleteConversation}
        onOpenSettings={() => setShowSettings(true)}
        isDarkMode={theme === 'dark'}
        onToggleDarkMode={toggleTheme}
      />
      <ChatInterface
        key={currentConversationId || 'no-conversation'}
        conversation={currentConversation}
        onSendMessage={handleSendMessage}
        isLoading={isLoading}
        isUploadProcessing={isUploadProcessing}
        error={error}
        onDismissError={() => setError(null)}
        backendOk={backendOk}
        onExport={handleExportMarkdown}
        onRerunAssistant={handleRerunAssistant}
      />
      {showSettings && (
        <Settings
          onClose={() => setShowSettings(false)}
          onSaved={handleSettingsSaved}
        />
      )}
    </div>
  );
}

export default App;
