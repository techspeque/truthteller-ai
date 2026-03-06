import { useState, useEffect, useRef, type FormEvent, type ChangeEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import Stage1 from './Stage1';
import Stage2 from './Stage2';
import Stage3 from './Stage3';
import CouncilInsights from './CouncilInsights';
import type { Conversation, Message, AssistantMessage, UserMessage } from '@/types/api';
import './ChatInterface.css';

interface ChatInterfaceProps {
  conversation: Conversation | null;
  onSendMessage: (content: string, files: File[]) => void;
  isLoading: boolean;
  isUploadProcessing: boolean;
  error: string | null;
  onDismissError: () => void;
  backendOk: boolean | null;
  onExport: () => void;
  onRerunAssistant: (assistantIndex: number, options: { stage?: string; includeModels?: string[]; chairmanModel?: string | null }) => void;
  insightsExpandedDefault?: boolean;
}

export default function ChatInterface({
  conversation,
  onSendMessage,
  isLoading,
  isUploadProcessing,
  error,
  onDismissError,
  backendOk,
  onExport,
  onRerunAssistant,
  insightsExpandedDefault = false,
}: ChatInterfaceProps) {
  const [input, setInput] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [expandedInsights, setExpandedInsights] = useState<Record<number, boolean>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversation]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if ((input.trim() || selectedFiles.length > 0) && !isLoading) {
      onSendMessage(input, selectedFiles);
      setInput('');
      setSelectedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleFilesSelected = (e: ChangeEvent<HTMLInputElement>) => {
    const newFiles = Array.from(e.target.files || []);
    if (newFiles.length === 0) return;
    setSelectedFiles((prev) => {
      const existingKeys = new Set(prev.map((file) => `${file.name}:${file.size}`));
      const deduped = newFiles.filter((file) => !existingKeys.has(`${file.name}:${file.size}`));
      return [...prev, ...deduped];
    });
  };

  const removeSelectedFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const formatFileSize = (sizeBytes: number) => {
    if (sizeBytes < 1024) return `${sizeBytes} B`;
    if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const messages: Message[] = conversation?.messages || [];
  const latestAssistantInsightIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'assistant' && message?.stage3) return i;
    }
    return -1;
  })();

  if (!conversation) {
    return (
      <div className="chat-interface">
        {backendOk === false && (
          <div className="error-banner backend-error">
            Backend unavailable. Make sure the server is running on port 8001.
          </div>
        )}
        <div className="empty-state">
          <h2>Welcome to TruthTeller AI</h2>
          <p>Create a new conversation to get started</p>
        </div>
      </div>
    );
  }

  const getNearestUserMessage = (index: number): UserMessage | null => {
    for (let i = index - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === 'user') {
        return msg;
      }
    }
    return null;
  };

  const getTiming = (message: AssistantMessage) => message.timing || message.metadata?.timing || null;

  const toggleInsights = (index: number) => {
    const defaultExpanded = Boolean(insightsExpandedDefault);
    setExpandedInsights((prev) => ({
      ...prev,
      [index]: !(
        Object.prototype.hasOwnProperty.call(prev, index)
          ? prev[index]
          : defaultExpanded
      ),
    }));
  };

  const isInsightsExpanded = (index: number) => (
    Boolean(
    Object.prototype.hasOwnProperty.call(expandedInsights, index)
      ? expandedInsights[index]
      : insightsExpandedDefault
    )
  );

  return (
    <div className="chat-interface">
      {backendOk === false && (
        <div className="error-banner backend-error">
          Backend unavailable. Make sure the server is running on port 8001.
        </div>
      )}
      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button className="error-dismiss" onClick={onDismissError}>
            Dismiss
          </button>
        </div>
      )}

      <div className="chat-header">
        <span className="chat-title">
          {conversation.title || 'New Conversation'}
        </span>
        {conversation.messages.length > 0 && (
          <button className="export-btn" onClick={onExport}>
            Export
          </button>
        )}
      </div>

      <div className="messages-container">
        {conversation.messages.length === 0 ? (
          <div className="empty-state">
            <h2>Start a conversation</h2>
            <p>Ask a question to consult the TruthTeller AI</p>
          </div>
        ) : (
          conversation.messages.map((msg, index) => {
            if (msg.role === 'user') {
              return (
                <div key={index} className="message-group">
                  <div className="user-message">
                    <div className="message-label">You</div>
                    <div className="message-content">
                      {msg.content ? (
                        <div className="markdown-content">
                          <ReactMarkdown>{msg.content}</ReactMarkdown>
                        </div>
                      ) : (
                        <div className="files-only-note">Files-only request</div>
                      )}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div className="message-attachments">
                          {msg.attachments.map((attachment, attachmentIndex) => (
                            <div key={`${attachment.filename}-${attachmentIndex}`} className="attachment-chip">
                              <span className="attachment-name">{attachment.filename}</span>
                              {attachment.size_bytes != null && (
                                <span className="attachment-size">{formatFileSize(attachment.size_bytes)}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            }

            // Assistant message
            const timing = getTiming(msg);
            return (
              <div key={index} className="message-group">
                <div className="assistant-message">
                  <div className="message-label">
                    TruthTeller AI
                    {timing && (
                      <span className="timing-badges">
                        {timing.stage1 != null && (
                          <span className="timing-badge">S1: {timing.stage1}s</span>
                        )}
                        {timing.stage2 != null && (
                          <span className="timing-badge">S2: {timing.stage2}s</span>
                        )}
                        {timing.stage3 != null && (
                          <span className="timing-badge">S3: {timing.stage3}s</span>
                        )}
                      </span>
                    )}
                  </div>

                  {msg.loading?.stage1 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Running Stage 1: Collecting individual responses...</span>
                    </div>
                  )}
                  {msg.stage1 && (
                    <Stage1
                      responses={msg.stage1}
                      failedModels={msg.failedModels || msg.metadata?.failed_models}
                      failedModelErrors={msg.failedModelErrors || msg.metadata?.failed_model_errors}
                    />
                  )}

                  {msg.loading?.stage2 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Running Stage 2: Peer rankings...</span>
                    </div>
                  )}
                  {msg.stage2 && (
                    <Stage2
                      rankings={msg.stage2}
                      labelToModel={msg.metadata?.label_to_model}
                      aggregateRankings={msg.metadata?.aggregate_rankings}
                    />
                  )}

                  {msg.loading?.stage3 && (
                    <div className="stage-loading">
                      <div className="spinner"></div>
                      <span>Running Stage 3: Final synthesis...</span>
                    </div>
                  )}
                  {msg.stage3 && <Stage3 finalResponse={msg.stage3} />}

                  {msg.stage3 && onRerunAssistant && (
                    <div className="insights-section">
                      <button
                        type="button"
                        className="insights-toggle"
                        onClick={() => toggleInsights(index)}
                        aria-expanded={isInsightsExpanded(index)}
                      >
                        {isInsightsExpanded(index) ? 'Hide' : 'Show'} Council Insights
                        {index === latestAssistantInsightIndex ? ' (latest)' : ''}
                      </button>
                      {isInsightsExpanded(index) && (
                        <CouncilInsights
                          assistantMessage={msg}
                          userMessage={getNearestUserMessage(index)}
                          assistantIndex={index}
                          onRerunAssistant={onRerunAssistant}
                          isBusy={isLoading}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {isUploadProcessing && (
          <div className="loading-indicator">
            <div className="spinner"></div>
            <span>Processing attachments...</span>
          </div>
        )}

        {isLoading && (
          <div className="loading-indicator">
            <div className="spinner"></div>
            <span>Consulting the council...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <form className="input-form" onSubmit={handleSubmit}>
        <input
          ref={fileInputRef}
          className="file-input-hidden"
          type="file"
          multiple
          accept=".txt,.md,.markdown,.pdf,.docx,.pptx"
          onChange={handleFilesSelected}
          disabled={isLoading}
        />

        <textarea
          className="message-input"
          placeholder="Ask your question... (or upload files and send)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
          rows={3}
        />
        <div className="composer-actions">
          <button
            type="button"
            className="attach-button"
            disabled={isLoading}
            onClick={() => fileInputRef.current?.click()}
          >
            Attach Files
          </button>
          <span className="composer-help">Supported: txt, md, pdf, docx, pptx</span>
        </div>
        {selectedFiles.length > 0 && (
          <div className="selected-files">
            {selectedFiles.map((file, index) => (
              <div key={`${file.name}-${file.size}-${index}`} className="selected-file-chip">
                <span className="selected-file-name">{file.name}</span>
                <span className="selected-file-size">{formatFileSize(file.size)}</span>
                <button
                  type="button"
                  className="selected-file-remove"
                  onClick={() => removeSelectedFile(index)}
                  disabled={isLoading}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="submit"
          className="send-button"
          disabled={(!input.trim() && selectedFiles.length === 0) || isLoading}
        >
          Send
        </button>
      </form>
    </div>
  );
}
