import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stage3 from './Stage3';

describe('Stage3', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('returns null when final response is missing', () => {
    const { container } = render(<Stage3 finalResponse={null as any} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders model/tokens and copies final response', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <Stage3
        finalResponse={{
          model: 'provider/chairman-model',
          response: 'Final answer body',
          usage: { total_tokens: 88 },
        }}
      />
    );

    expect(screen.getByText('Chairman: chairman-model')).toBeInTheDocument();
    expect(screen.getByText('88 tokens')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('Final answer body');
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    });
  });

  it('logs warning when clipboard write fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

    render(
      <Stage3
        finalResponse={{
          model: 'provider/chairman-model',
          response: 'Final answer body',
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
