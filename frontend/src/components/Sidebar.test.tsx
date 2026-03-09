import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar';

const conversations = [
  { id: 'conv-1', title: 'Alpha thread', created_at: '2026-03-09T12:00:00Z', message_count: 3 },
  { id: 'conv-2', title: 'Beta thread', created_at: '2026-03-09T12:01:00Z', message_count: 4 },
];

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  function renderSidebar(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
    const props: ComponentProps<typeof Sidebar> = {
      conversations,
      currentConversationId: 'conv-1',
      onSelectConversation: vi.fn(),
      onNewConversation: vi.fn(),
      onDeleteConversation: vi.fn(),
      onOpenSettings: vi.fn(),
      isDarkMode: false,
      onToggleDarkMode: vi.fn(),
      ...overrides,
    };

    const view = render(<Sidebar {...props} />);
    return { ...view, props };
  }

  it('renders full sidebar interactions and delete confirm flow', async () => {
    vi.useFakeTimers();
    const { props } = renderSidebar();

    fireEvent.click(screen.getByText('Alpha thread'));
    expect(props.onSelectConversation).toHaveBeenCalledWith('conv-1');

    fireEvent.change(screen.getByPlaceholderText('Search conversations...'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No matching conversations')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search conversations...'), {
      target: { value: '' },
    });

    fireEvent.click(screen.getAllByLabelText('Delete conversation')[0]!);
    expect(screen.getByLabelText('Confirm deletion')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Cancel deletion'));
    expect(props.onDeleteConversation).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByLabelText('Delete conversation')[0]!);
    fireEvent.click(screen.getByLabelText('Confirm deletion'));
    expect(props.onDeleteConversation).toHaveBeenCalledWith('conv-1');

    fireEvent.click(screen.getAllByLabelText('Delete conversation')[0]!);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByLabelText('Confirm deletion')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('collapses and expands while persisting localStorage state', () => {
    const { props } = renderSidebar();

    fireEvent.click(screen.getByTitle('Collapse sidebar'));
    expect(localStorage.getItem('sidebar-collapsed')).toBe('true');

    fireEvent.click(screen.getByTitle('Alpha thread'));
    expect(props.onSelectConversation).toHaveBeenCalledWith('conv-1');

    fireEvent.click(screen.getByTitle('Expand sidebar'));
    expect(localStorage.getItem('sidebar-collapsed')).toBe('false');
  });

  it('starts in collapsed mode from localStorage and supports top controls', () => {
    localStorage.setItem('sidebar-collapsed', 'true');
    const { props } = renderSidebar({ isDarkMode: true });

    fireEvent.click(screen.getByTitle('Light mode'));
    fireEvent.click(screen.getByTitle('Settings'));
    fireEvent.click(screen.getByTitle('New conversation'));

    expect(props.onToggleDarkMode).toHaveBeenCalledTimes(1);
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(props.onNewConversation).toHaveBeenCalledTimes(1);
  });
});
