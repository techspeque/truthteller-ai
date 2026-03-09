import { describe, expect, it } from 'vitest';
import type { AttachmentMetadata, FinalResult, RankingResult, StageResult } from '@/types/api';
import {
  buildConsensusData,
  buildInfluenceData,
  buildTraceabilityData,
  buildDiffData,
  buildUncertaintyData,
  buildCostLatencyRows,
  formatNumber,
  modelLabel,
} from './insights';

const stage1: StageResult[] = [
  {
    model: 'provider/model-a',
    response: 'Revenue increased by 10 percent. Evidence supports this estimate.',
    latency_seconds: 1,
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  },
  {
    model: 'provider/model-b',
    response: 'Revenue increased by 10 percent. Timeline depends on approvals and evidence.',
    latency_seconds: 2,
    usage: { prompt_tokens: 11, completion_tokens: 21, total_tokens: 32 },
  },
  {
    model: 'provider/model-c',
    response: 'Revenue may stay flat. The baseline assumption is uncertain.',
    latency_seconds: 3,
    usage: { prompt_tokens: 12, completion_tokens: 22, total_tokens: 34 },
  },
];

const stage2: RankingResult[] = [
  {
    model: 'judge/ranker-1',
    ranking: 'A > B > C',
    parsed_ranking: ['Response A', 'Response B', 'Response C'],
    latency_seconds: 4,
    usage: { prompt_tokens: 8, completion_tokens: 10, total_tokens: 18 },
  },
  {
    model: 'judge/ranker-2',
    ranking: 'B > A > C',
    parsed_ranking: ['Response B', 'Response A'],
    latency_seconds: 5,
    usage: { prompt_tokens: 9, completion_tokens: 11, total_tokens: 20 },
  },
];

const stage3: FinalResult = {
  model: 'provider/model-b',
  response:
    'The report.pdf indicates revenue growth of 10 percent.\n\nThe outcome is unclear and depends on market variance?',
  latency_seconds: 6,
  usage: { prompt_tokens: 7, completion_tokens: 13, total_tokens: 20 },
};

describe('insights utilities', () => {
  it('builds consensus data with fallback labels and computes agreement', () => {
    const result = buildConsensusData(stage1, stage2, {
      aggregate_rankings: [],
      failed_models: [],
    });

    expect(result.candidateModels).toEqual(['provider/model-a', 'provider/model-b', 'provider/model-c']);
    expect(result.matrix).toHaveLength(2);
    expect(result.matrix[1]?.ranks).toEqual([2, 1, 3]);
    expect(result.consensusScore).toBeCloseTo(2 / 3, 5);
    expect(result.labelToModel['Response A']).toBe('provider/model-a');
  });

  it('uses metadata label mapping and normalizes duplicate or unknown rankings', () => {
    const result = buildConsensusData(stage1, [
      {
        model: 'judge/ranker-x',
        ranking: 'custom',
        parsed_ranking: ['First', 'First', 'Second', 'Unknown'],
      },
    ], {
      label_to_model: {
        First: 'provider/model-c',
        Second: 'provider/model-a',
      },
      aggregate_rankings: [],
      failed_models: [],
    });

    expect(result.rankOrders[0]?.order).toEqual([
      'provider/model-c',
      'provider/model-a',
      'provider/model-b',
    ]);
  });

  it('builds influence edges, traceability mappings, and sentence diffs', () => {
    const consensus = buildConsensusData(stage1, stage2, {
      aggregate_rankings: [
        { model: 'provider/model-b', average_rank: 1.2, rankings_count: 2 },
        { model: 'provider/model-a', average_rank: 1.8, rankings_count: 2 },
        { model: 'provider/model-c', average_rank: 3, rankings_count: 2 },
      ],
      failed_models: [],
    });

    const influence = buildInfluenceData(stage1, stage2, stage3, {
      aggregate_rankings: [
        { model: 'provider/model-b', average_rank: 1.2, rankings_count: 2 },
        { model: 'provider/model-a', average_rank: 1.8, rankings_count: 2 },
        { model: 'provider/model-c', average_rank: 3, rankings_count: 2 },
      ],
      failed_models: [],
    }, consensus);

    expect(influence.finalModel).toBe('provider/model-b');
    expect(influence.stage1ToStage2).toHaveLength(6);
    expect(influence.stage2ToFinal).toHaveLength(2);
    expect(influence.stage2ToFinal[0]?.weight).toBeGreaterThan(0);

    const attachments: AttachmentMetadata[] = [
      {
        id: 'a1',
        filename: 'report.pdf',
        size_bytes: 1234,
        preview: 'Revenue growth details and evidence in the financial report',
      },
    ];
    const trace = buildTraceabilityData(stage1, stage3, attachments);
    expect(trace).toHaveLength(2);
    expect(trace[0]?.modelSupport.length).toBeGreaterThan(0);
    expect(trace[0]?.fileSupport[0]?.filename).toBe('report.pdf');

    const diff = buildDiffData(stage1, 'provider/model-a', 'provider/model-b');
    expect(diff.shared.some((s) => /Revenue increased by 10 percent\./i.test(s))).toBe(true);
    expect(diff.leftOnly.some((s) => /Evidence supports this estimate\./i.test(s))).toBe(true);
    expect(diff.rightOnly.some((s) => /Timeline depends on approvals/i.test(s))).toBe(true);
  });

  it('computes uncertainty and cost-latency aggregates', () => {
    const consensus = buildConsensusData(stage1, stage2, {
      aggregate_rankings: [
        { model: 'provider/model-a', average_rank: 1.2, rankings_count: 2 },
        { model: 'provider/model-b', average_rank: 2.1, rankings_count: 2 },
        { model: 'provider/model-c', average_rank: 2.9, rankings_count: 2 },
      ],
      failed_models: ['provider/model-z'],
    });

    const uncertainty = buildUncertaintyData(stage1, stage2, stage3, {
      aggregate_rankings: [
        { model: 'provider/model-a', average_rank: 1.2, rankings_count: 2 },
        { model: 'provider/model-b', average_rank: 2.1, rankings_count: 2 },
        { model: 'provider/model-c', average_rank: 2.9, rankings_count: 2 },
      ],
      failed_models: ['provider/model-z'],
    }, consensus);

    expect(uncertainty.successRate).toBe(75);
    expect(uncertainty.confidenceScore).toBeGreaterThanOrEqual(0);
    expect(uncertainty.confidenceScore).toBeLessThanOrEqual(100);
    expect(uncertainty.openQuestions.length).toBeGreaterThan(0);
    expect(uncertainty.hotspots.some((entry) => entry.token === 'evidence')).toBe(true);

    const costLatency = buildCostLatencyRows(stage1, stage2, stage3, {
      aggregate_rankings: [],
      failed_models: ['provider/model-z'],
      timing: { stage1: 3, stage2: 2, stage3: 1 },
    });

    expect(costLatency.rows).toHaveLength(6);
    expect(costLatency.totals).toEqual({
      prompt_tokens: 57,
      completion_tokens: 97,
      total_tokens: 154,
    });
    expect(costLatency.failedModels).toEqual(['provider/model-z']);
    expect(costLatency.stageTiming.stage1).toBe(3);
  });

  it('formats numbers and labels models safely', () => {
    expect(formatNumber(12345)).toMatch(/12[,.\s]?345/);
    expect(modelLabel('provider/model-a')).toBe('model-a');
    expect(modelLabel('')).toBe('unknown');
  });

  it('returns defaults for empty inputs', () => {
    const emptyConsensus = buildConsensusData([], [], {});
    const emptyInfluence = buildInfluenceData([], [], null, {}, null);

    expect(emptyConsensus.consensusScore).toBe(0);
    expect(emptyConsensus.matrix).toEqual([]);
    expect(emptyInfluence.finalModel).toBe('final');
    expect(buildTraceabilityData([], null, [])).toEqual([]);
    expect(buildDiffData([], 'a', 'b')).toEqual({ shared: [], leftOnly: [], rightOnly: [] });
  });
});
