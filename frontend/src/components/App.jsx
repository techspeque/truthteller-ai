import { useState, useEffect } from 'react';
import Sidebar from './Sidebar';
import ChatInterface from './ChatInterface';
import Settings from './Settings';
import { api } from '@/lib/transport';
import { log } from '@/lib/logger';
import './App.css';

function App() {
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [currentConversation, setCurrentConversation] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isUploadProcessing, setIsUploadProcessing] = useState(false);
  const [error, setError] = useState(null);
  const [backendOk, setBackendOk] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [insightsExpandedDefault, setInsightsExpandedDefault] = useState(false);
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = localStorage.getItem('t2ai-theme');
    return stored === 'dark' ? 'dark' : 'light';
  });

  const loadConversations = async () => {
    try {
      const convs = await api.listConversations();
      setConversations(convs);
    } catch (err) {
      log.error('Failed to load conversations', { error: err.message });
    }
  };

  // Health check + load conversations on mount
  useEffect(() => {
    api.healthCheck()
      .then(() => setBackendOk(true))
      .catch((err) => {
        log.warn('Backend health check failed', { error: err.message });
        setBackendOk(false);
      });

    api.listConversations()
      .then((convs) => setConversations(convs))
      .catch((err) => log.error('Failed to load conversations', { error: err.message }));

    api.getConfig()
      .then((cfg) => setInsightsExpandedDefault(Boolean(cfg.insights_expanded_default)))
      .catch((err) => log.warn('Failed to load config defaults', { error: err.message }));
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

  // Load conversation details when selected
  useEffect(() => {
    if (currentConversationId) {
      api.getConversation(currentConversationId)
        .then((conv) => setCurrentConversation(conv))
        .catch((err) => log.error('Failed to load conversation', { conversationId: currentConversationId, error: err.message }));
    }
  }, [currentConversationId]);

  const handleNewConversation = async () => {
    try {
      const newConv = await api.createConversation();
      setConversations([
        { id: newConv.id, created_at: newConv.created_at, title: newConv.title, message_count: 0 },
        ...conversations,
      ]);
      setCurrentConversationId(newConv.id);
    } catch (err) {
      log.error('Failed to create conversation', { error: err.message });
      setError('Failed to create conversation');
    }
  };

  const handleSelectConversation = (id) => {
    setCurrentConversationId(id);
  };

  const handleDeleteConversation = async (id) => {
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
      log.error('Failed to delete conversation', { conversationId: id, error: err.message });
      setError(err.message || 'Failed to delete conversation');
    }
  };

  const handleSendMessage = async (content, files = []) => {
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

      // Optimistically add user message to UI
      const userMessage = { role: 'user', content, attachments: optimisticAttachments };
      setCurrentConversation((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
      }));

      // Create a partial assistant message that will be updated progressively
      const assistantMessage = {
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

      // Add the partial assistant message
      setCurrentConversation((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
      }));

      // Send message with streaming
      await api.sendMessageStream(currentConversationId, content, files, (eventType, event) => {
        switch (eventType) {
          case 'upload_processing_start':
            setIsUploadProcessing(true);
            break;

          case 'upload_processing_complete':
            setIsUploadProcessing(false);
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              if (messages.length < 2) return prev;
              const userIndex = messages.length - 2;
              const userMsg = { ...messages[userIndex] };
              if (userMsg.role !== 'user') return prev;
              userMsg.attachments = event.attachments || userMsg.attachments;
              messages[userIndex] = userMsg;
              return { ...prev, messages };
            });
            break;

          case 'stage1_start':
            setIsUploadProcessing(false);
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              lastMsg.loading = { ...lastMsg.loading, stage1: true };
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            break;

          case 'stage1_complete':
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              lastMsg.stage1 = event.data;
              lastMsg.loading = { ...lastMsg.loading, stage1: false };
              lastMsg.timing = { ...lastMsg.timing, stage1: event.timing };
              lastMsg.failedModels = event.failed_models || [];
              lastMsg.failedModelErrors = event.failed_model_errors || {};
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            break;

          case 'stage2_start':
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              lastMsg.loading = { ...lastMsg.loading, stage2: true };
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            break;

          case 'stage2_complete':
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              lastMsg.stage2 = event.data;
              lastMsg.metadata = event.metadata;
              lastMsg.loading = { ...lastMsg.loading, stage2: false };
              lastMsg.timing = { ...lastMsg.timing, stage2: event.timing };
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            break;

          case 'stage3_start':
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              lastMsg.loading = { ...lastMsg.loading, stage3: true };
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            break;

          case 'stage3_complete':
            setCurrentConversation((prev) => {
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              lastMsg.stage3 = event.data;
              lastMsg.loading = { ...lastMsg.loading, stage3: false };
              lastMsg.timing = { ...lastMsg.timing, stage3: event.timing };
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            break;

          case 'title_complete':
            loadConversations();
            setCurrentConversation((prev) => {
              if (prev?.id !== currentConversationId) return prev;
              return { ...prev, title: event.data.title };
            });
            break;

          case 'complete':
            loadConversations();
            setIsUploadProcessing(false);
            setCurrentConversation((prev) => {
              if (!prev?.messages?.length) return prev;
              const messages = [...prev.messages];
              const lastMsg = { ...messages[messages.length - 1] };
              if (lastMsg?.role !== 'assistant') return prev;
              if (event.metadata) {
                lastMsg.metadata = event.metadata;
                if (event.metadata.timing) {
                  lastMsg.timing = { ...lastMsg.timing, ...event.metadata.timing };
                }
              }
              messages[messages.length - 1] = lastMsg;
              return { ...prev, messages };
            });
            setIsLoading(false);
            break;

          case 'error':
            setIsUploadProcessing(false);
            setError(event.message || 'An error occurred during council deliberation');
            setCurrentConversation((prev) => {
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
      log.error('Message send failed', { conversationId: currentConversationId, error: err.message });
      setIsUploadProcessing(false);
      setError(err.message || 'Failed to send message');
      // Remove optimistic messages on error
      setCurrentConversation((prev) => ({
        ...prev,
        messages: prev.messages.slice(0, -2),
      }));
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

    // Trigger download
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(currentConversation.title || 'conversation').replace(/[^a-z0-9]/gi, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRerunAssistant = async (assistantIndex, options) => {
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
      log.error('Rerun failed', { conversationId: currentConversationId, error: err.message });
      setError(err.message || 'Failed to re-run council stages');
    } finally {
      setIsLoading(false);
    }
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const handleSettingsSaved = (updatedConfig) => {
    setInsightsExpandedDefault(Boolean(updatedConfig?.insights_expanded_default));
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
        insightsExpandedDefault={insightsExpandedDefault}
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
