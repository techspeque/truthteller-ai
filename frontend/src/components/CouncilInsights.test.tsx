import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, UserMessage } from '@/types/api';
import CouncilInsights from './CouncilInsights';

function buildAssistantMessage(): AssistantMessage {
  return {
    role: 'assistant',
    stage1: [
      {
        model: 'provider/model-a',
        response: 'Alpha claim. Shared claim. Evidence from report.',
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        latency_seconds: 1,
      },
      {
        model: 'provider/model-b',
        response: 'Beta claim. Shared claim. Alternative interpretation.',
        usage: { prompt_tokens: 11, completion_tokens: 21, total_tokens: 32 },
        latency_seconds: 2,
      },
      {
        model: 'provider/model-c',
        response: 'Gamma claim. Shared claim. Cautious outlook.',
        usage: { prompt_tokens: 12, completion_tokens: 22, total_tokens: 34 },
        latency_seconds: 3,
      },
    ],
    stage2: [
      {
        model: 'judge/ranker-1',
        ranking: 'A > B > C',
        parsed_ranking: ['Response A', 'Response B', 'Response C'],
        usage: { prompt_tokens: 8, completion_tokens: 10, total_tokens: 18 },
        latency_seconds: 4,
      },
      {
        model: 'judge/ranker-2',
        ranking: 'B > A > C',
        parsed_ranking: ['Response B', 'Response A', 'Response C'],
        usage: { prompt_tokens: 9, completion_tokens: 11, total_tokens: 20 },
        latency_seconds: 5,
      },
    ],
    stage3: {
      model: 'provider/model-b',
      response: 'Final recommendation references report.pdf.\n\nOpen question remains?',
      usage: { prompt_tokens: 7, completion_tokens: 13, total_tokens: 20 },
      latency_seconds: 6,
    },
    metadata: {
      aggregate_rankings: [
        { model: 'provider/model-b', average_rank: 1, rankings_count: 2 },
        { model: 'provider/model-a', average_rank: 2, rankings_count: 2 },
        { model: 'provider/model-c', average_rank: 3, rankings_count: 2 },
      ],
      failed_models: ['provider/model-z'],
      timing: { stage1: 1, stage2: 2, stage3: 3 },
    },
  };
}

const userMessage: UserMessage = {
  role: 'user',
  content: 'Analyze this file',
  attachments: [
    {
      id: 'f1',
      filename: 'report.pdf',
      size_bytes: 2048,
      preview: 'Report evidence and growth details',
      trace_excerpt: 'Growth evidence in report',
    },
  ],
};

describe('CouncilInsights', () => {
  it('renders nothing when stage3 is missing', () => {
    const noStage3: AssistantMessage = {
      role: 'assistant',
      stage1: [],
      stage2: [],
      stage3: null,
      metadata: { aggregate_rankings: [], failed_models: [] },
    };

    const { container } = render(
      <CouncilInsights
        assistantMessage={noStage3}
        userMessage={userMessage}
        assistantIndex={2}
        onRerunAssistant={vi.fn()}
        isBusy={false}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders all major insight sections and handles rerun controls', () => {
    const onRerunAssistant = vi.fn();
    render(
      <CouncilInsights
        assistantMessage={buildAssistantMessage()}
        userMessage={userMessage}
        assistantIndex={5}
        onRerunAssistant={onRerunAssistant}
        isBusy={false}
      />
    );

    expect(screen.getByText('Consensus Matrix')).toBeInTheDocument();
    expect(screen.getByText('Influence Graph')).toBeInTheDocument();
    expect(screen.getByText('Final Answer Traceability')).toBeInTheDocument();
    expect(screen.getByText('Side-by-Side Diff')).toBeInTheDocument();
    expect(screen.getByText('Uncertainty Panel')).toBeInTheDocument();
    expect(screen.getByText('Cost & Latency Breakdown')).toBeInTheDocument();
    expect(screen.getByText('Interactive Rerun Controls')).toBeInTheDocument();

    expect(screen.getByText('Failed models: model-z')).toBeInTheDocument();
    expect(screen.getByText('Stage 1: 1s')).toBeInTheDocument();
    expect(screen.getByText('Stage 2: 2s')).toBeInTheDocument();
    expect(screen.getByText('Stage 3: 3s')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Left'), { target: { value: 'provider/model-b' } });
    fireEvent.change(screen.getByLabelText('Right'), { target: { value: 'provider/model-c' } });

    fireEvent.click(screen.getByRole('checkbox', { name: 'model-a' }));
    fireEvent.change(screen.getByDisplayValue('provider/model-b'), { target: { value: 'provider/model-c' } });
    fireEvent.click(screen.getByRole('button', { name: 'Re-run Stage 2 + 3' }));

    expect(onRerunAssistant).toHaveBeenCalledWith(5, {
      stage: 'stage2',
      includeModels: ['provider/model-b', 'provider/model-c'],
      chairmanModel: 'provider/model-c',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Re-run Stage 3 only' }));
    expect(onRerunAssistant).toHaveBeenCalledWith(5, {
      stage: 'stage3',
      includeModels: ['provider/model-b', 'provider/model-c'],
      chairmanModel: 'provider/model-c',
    });
  });

  it('falls back to all models when all checkboxes are deselected', () => {
    const onRerunAssistant = vi.fn();
    render(
      <CouncilInsights
        assistantMessage={buildAssistantMessage()}
        userMessage={userMessage}
        assistantIndex={1}
        onRerunAssistant={onRerunAssistant}
        isBusy={false}
      />
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'model-a' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'model-b' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'model-c' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-run Stage 3 only' }));

    expect(onRerunAssistant).toHaveBeenCalledWith(1, {
      stage: 'stage3',
      includeModels: ['provider/model-a', 'provider/model-b', 'provider/model-c'],
      chairmanModel: 'provider/model-b',
    });
  });

  it('disables rerun controls when busy', () => {
    render(
      <CouncilInsights
        assistantMessage={buildAssistantMessage()}
        userMessage={userMessage}
        assistantIndex={0}
        onRerunAssistant={vi.fn()}
        isBusy
      />
    );

    expect(screen.getByDisplayValue('provider/model-b')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-run Stage 2 + 3' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-run Stage 3 only' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'model-a' })).toBeDisabled();
  });

  it('shows empty matrix and traceability states when inputs are sparse', () => {
    const sparseAssistant: AssistantMessage = {
      role: 'assistant',
      stage1: [{ model: 'provider/model-a', response: 'Single answer only.' }],
      stage2: [],
      stage3: { model: 'provider/model-a', response: '' },
      metadata: { aggregate_rankings: [], failed_models: [] },
    };

    render(
      <CouncilInsights
        assistantMessage={sparseAssistant}
        userMessage={{ role: 'user', content: 'x', attachments: [] }}
        assistantIndex={3}
        onRerunAssistant={vi.fn()}
        isBusy={false}
      />
    );

    expect(screen.getByText('No ranking matrix available for this response.')).toBeInTheDocument();
    expect(screen.getByText('No final paragraphs available for traceability mapping.')).toBeInTheDocument();
    expect(screen.getByText('No explicit unresolved questions detected in final answer.')).toBeInTheDocument();
  });
});
