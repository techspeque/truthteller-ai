import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Stage2 from './Stage2';

describe('Stage2', () => {
  it('returns null when there are no rankings', () => {
    const { container } = render(<Stage2 rankings={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders rankings, de-anonymizes labels, and shows aggregate rankings', () => {
    render(
      <Stage2
        rankings={[
          {
            model: 'provider/evaluator-a',
            ranking: 'Response A beats Response B',
            parsed_ranking: ['Response A', 'Response B'],
          },
          {
            model: 'provider/evaluator-b',
            ranking: 'Response B beats Response A',
            parsed_ranking: ['Response B', 'Response A'],
          },
        ]}
        labelToModel={{
          'Response A': 'provider/model-x',
          'Response B': 'provider/model-y',
        }}
        aggregateRankings={[
          { model: 'provider/model-x', average_rank: 1.5, rankings_count: 2 },
          { model: 'provider/model-y', average_rank: 2, rankings_count: 2 },
        ]}
      />
    );

    expect(screen.getByText('evaluator-a')).toBeInTheDocument();
    expect(screen.getAllByText((_, element) => element?.textContent === 'model-x beats model-y').length).toBeGreaterThan(0);
    expect(screen.getByText('Avg: 1.50')).toBeInTheDocument();
    expect(screen.getAllByText('(2 votes)')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'evaluator-b' }));
    expect(screen.getByText('provider/evaluator-b')).toBeInTheDocument();
    expect(screen.getAllByText((_, element) => element?.textContent === 'model-y beats model-x').length).toBeGreaterThan(0);
  });

  it('falls back to raw parsed labels when no label mapping is provided', () => {
    render(
      <Stage2
        rankings={[
          {
            model: 'provider/evaluator-a',
            ranking: 'Response A then Response B',
            parsed_ranking: ['Response A', 'Response B'],
          },
        ]}
      />
    );

    expect(screen.getByText('Response A')).toBeInTheDocument();
    expect(screen.getByText('Response B')).toBeInTheDocument();
  });
});
