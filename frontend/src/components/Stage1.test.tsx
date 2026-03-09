import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stage1 from './Stage1';

describe('Stage1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('returns null when there are no responses and no failures', () => {
    const { container } = render(<Stage1 responses={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders tabs, failed models, and switches active response', () => {
    render(
      <Stage1
        responses={[
          { model: 'provider/model-a', response: 'First response', usage: { total_tokens: 11 } },
          { model: 'provider/model-b', response: 'Second response' },
        ]}
        failedModels={['provider/model-a', 'provider/model-c']}
        failedModelErrors={{ 'provider/model-c': 'timeout' }}
      />
    );

    expect(screen.getByText('model-a')).toBeInTheDocument();
    expect(screen.getByText('model-b')).toBeInTheDocument();
    expect(screen.getByText('model-c (failed)')).toBeInTheDocument();
    expect(screen.getByText('timeout')).toBeInTheDocument();
    expect(screen.getByText('11 tokens')).toBeInTheDocument();
    expect(screen.getByText('First response')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'model-b' }));
    expect(screen.getByText('Second response')).toBeInTheDocument();
  });

  it('copies active response text to clipboard and updates copy label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <Stage1
        responses={[{ model: 'provider/model-a', response: 'Copy me' }]}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('Copy me');
      expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
    });
  });

  it('handles clipboard failures without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('clipboard disabled'));

    render(<Stage1 responses={[{ model: 'provider/model-a', response: 'No copy' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
