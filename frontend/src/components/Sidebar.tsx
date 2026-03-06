import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ConversationSummary } from '@/types/api';
import './Sidebar.css';

const IconSun = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v2m0 10v2M3.05 3.05l1.41 1.41m7.08 7.08l1.41 1.41M1 8h2m10 0h2M3.05 12.95l1.41-1.41m7.08-7.08l1.41-1.41" />
  </svg>
);

const IconMoon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 8.5A6.5 6.5 0 017.5 2 5.5 5.5 0 1014 8.5z" />
  </svg>
);

const IconGear = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="2" />
    <path d="M13.3 10a1.2 1.2 0 00.24 1.32l.04.04a1.45 1.45 0 11-2.05 2.05l-.04-.04a1.2 1.2 0 00-1.32-.24 1.2 1.2 0 00-.73 1.1v.12a1.45 1.45 0 11-2.9 0v-.06a1.2 1.2 0 00-.78-1.1 1.2 1.2 0 00-1.32.24l-.04.04a1.45 1.45 0 11-2.05-2.05l.04-.04a1.2 1.2 0 00.24-1.32 1.2 1.2 0 00-1.1-.73H1.45a1.45 1.45 0 110-2.9h.06a1.2 1.2 0 001.1-.78 1.2 1.2 0 00-.24-1.32l-.04-.04A1.45 1.45 0 114.38 2.18l.04.04a1.2 1.2 0 001.32.24h.06a1.2 1.2 0 00.73-1.1V1.24a1.45 1.45 0 112.9 0v.06a1.2 1.2 0 00.73 1.1 1.2 1.2 0 001.32-.24l.04-.04a1.45 1.45 0 112.05 2.05l-.04.04a1.2 1.2 0 00-.24 1.32v.06a1.2 1.2 0 001.1.73h.12a1.45 1.45 0 110 2.9h-.06a1.2 1.2 0 00-1.1.73z" />
  </svg>
);

const IconPlus = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3v10M3 8h10" />
  </svg>
);

const IconChevronLeft = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 3L5 8l5 5" />
  </svg>
);

const IconChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3l5 5-5 5" />
  </svg>
);

const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 4.5h11" />
    <path d="M6.2 2.5h3.6" />
    <path d="M5 4.5V13a1 1 0 001 1h4a1 1 0 001-1V4.5" />
    <path d="M6.8 7v4.2M9.2 7v4.2" />
  </svg>
);

const IconX = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

const IconCheck = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3.5 8.5l3 3 6-6" />
  </svg>
);

function conversationInitial(title: string | undefined): string {
  const t = (title || 'N').trim();
  return t[0]!.toUpperCase();
}

interface SidebarProps {
  conversations: ConversationSummary[];
  currentConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
  onOpenSettings: () => void;
  isDarkMode: boolean;
  onToggleDarkMode: () => void;
}

export default function Sidebar({
  conversations,
  currentConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
  onOpenSettings,
  isDarkMode,
  onToggleDarkMode,
}: SidebarProps) {
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('sidebar-collapsed') === 'true';
  });
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingDeleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingDeleteTimer = () => {
    if (pendingDeleteTimerRef.current) {
      clearTimeout(pendingDeleteTimerRef.current);
      pendingDeleteTimerRef.current = null;
    }
  };

  useEffect(() => () => {
    clearPendingDeleteTimer();
  }, []);

  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', String(collapsed));
  }, [collapsed]);

  const filtered = search.trim()
    ? conversations.filter((c) =>
        (c.title || '').toLowerCase().includes(search.toLowerCase())
      )
    : conversations;

  const startDelete = (e: MouseEvent, id: string) => {
    e.stopPropagation();
    setPendingDeleteId(id);
    clearPendingDeleteTimer();
    pendingDeleteTimerRef.current = setTimeout(() => {
      setPendingDeleteId(null);
      pendingDeleteTimerRef.current = null;
    }, 3000);
  };

  const cancelDelete = (e: MouseEvent) => {
    e.stopPropagation();
    clearPendingDeleteTimer();
    setPendingDeleteId(null);
  };

  const confirmDelete = (e: MouseEvent, id: string) => {
    e.stopPropagation();
    clearPendingDeleteTimer();
    setPendingDeleteId(null);
    onDeleteConversation(id);
  };

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <div className="sidebar-collapsed-top">
          <button className="icon-btn" onClick={onToggleDarkMode} title={isDarkMode ? 'Light mode' : 'Dark mode'}>
            {isDarkMode ? <IconSun /> : <IconMoon />}
          </button>
          <button className="icon-btn" onClick={onOpenSettings} title="Settings">
            <IconGear />
          </button>
          <button className="icon-btn icon-btn-primary" onClick={onNewConversation} title="New conversation">
            <IconPlus />
          </button>
        </div>

        <div className="sidebar-collapsed-list">
          {conversations.slice(0, 20).map((conv) => (
            <button
              key={conv.id}
              className={`sidebar-collapsed-item ${conv.id === currentConversationId ? 'active' : ''}`}
              onClick={() => onSelectConversation(conv.id)}
              title={conv.title || 'New Conversation'}
            >
              {conversationInitial(conv.title)}
            </button>
          ))}
        </div>

        <div className="sidebar-collapsed-bottom">
          <button className="icon-btn" onClick={() => setCollapsed(false)} title="Expand sidebar">
            <IconChevronRight />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title-row">
          <h1>TruthTeller AI</h1>
          <div className="sidebar-controls">
            <button className="icon-btn" onClick={onToggleDarkMode} title={isDarkMode ? 'Light mode' : 'Dark mode'}>
              {isDarkMode ? <IconSun /> : <IconMoon />}
            </button>
            <button className="icon-btn" onClick={onOpenSettings} title="Settings">
              <IconGear />
            </button>
          </div>
        </div>
        <button className="new-conversation-btn" onClick={onNewConversation}>
          + New Conversation
        </button>
      </div>

      <div className="search-container">
        <input
          type="text"
          className="search-input"
          placeholder="Search conversations..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="conversation-list">
        {filtered.length === 0 ? (
          <div className="no-conversations">
            {search.trim() ? 'No matching conversations' : 'No conversations yet'}
          </div>
        ) : (
          filtered.map((conv) => (
            <div
              key={conv.id}
              className={`conversation-item ${conv.id === currentConversationId ? 'active' : ''} ${pendingDeleteId === conv.id ? 'pending-delete' : ''}`}
              onClick={() => onSelectConversation(conv.id)}
            >
              <div className="conversation-item-content">
                <div className="conversation-title">
                  {conv.title || 'New Conversation'}
                </div>
                <div className="conversation-meta">
                  {conv.message_count} messages
                </div>
              </div>
              <div className="conversation-actions">
                {pendingDeleteId === conv.id ? (
                  <>
                    <button
                      className="action-btn action-btn-cancel"
                      onClick={cancelDelete}
                      title="Cancel deletion"
                      aria-label="Cancel deletion"
                    >
                      <IconX />
                    </button>
                    <button
                      className="action-btn action-btn-confirm"
                      onClick={(e) => confirmDelete(e, conv.id)}
                      title="Confirm deletion"
                      aria-label="Confirm deletion"
                    >
                      <IconCheck />
                    </button>
                  </>
                ) : (
                  <button
                    className="action-btn action-btn-delete"
                    onClick={(e) => startDelete(e, conv.id)}
                    title="Delete conversation"
                    aria-label="Delete conversation"
                  >
                    <IconTrash />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-footer">
        <button className="icon-btn" onClick={() => setCollapsed(true)} title="Collapse sidebar">
          <IconChevronLeft />
        </button>
      </div>
    </div>
  );
}
