import type {
  StageResult,
  RankingResult,
  FinalResult,
  CouncilMetadata,
  AttachmentMetadata,
} from '@/types/api';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'being', 'been', 'it', 'this', 'that', 'these', 'those', 'as', 'at', 'by', 'from', 'but', 'if',
  'then', 'than', 'so', 'such', 'into', 'out', 'about', 'over', 'under', 'you', 'your', 'we', 'our',
  'they', 'their', 'he', 'she', 'his', 'her', 'them', 'can', 'could', 'should', 'would', 'will', 'may',
  'might', 'must', 'not', 'no', 'yes', 'do', 'does', 'did', 'done', 'have', 'has', 'had', 'also', 'very',
]);

function shortModel(model: string): string {
  if (!model) return 'unknown';
  return model.split('/')[1] || model;
}

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

function jaccard(aSet: Set<string>, bSet: Set<string>): number {
  if (!aSet.size || !bSet.size) return 0;
  let intersection = 0;
  for (const item of aSet) {
    if (bSet.has(item)) intersection += 1;
  }
  const union = new Set([...aSet, ...bSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function parseLabelToModelFallback(stage1: StageResult[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  stage1.forEach((item, index) => {
    const label = `Response ${String.fromCharCode(65 + index)}`;
    mapping[label] = item.model;
  });
  return mapping;
}

function normalizedOrderFromParsed(
  parsed: string[],
  labelToModel: Record<string, string>,
  allModels: string[]
): string[] {
  const mapped: string[] = [];
  const seen = new Set<string>();

  for (const label of parsed) {
    const model = labelToModel[label];
    if (model && !seen.has(model)) {
      mapped.push(model);
      seen.add(model);
    }
  }

  for (const model of allModels) {
    if (!seen.has(model)) {
      mapped.push(model);
      seen.add(model);
    }
  }

  return mapped;
}

function rankMapFromOrder(order: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  order.forEach((model, index) => {
    out[model] = index + 1;
  });
  return out;
}

function kendallTau(orderA: string[], orderB: string[]): number {
  if (!orderA.length || orderA.length !== orderB.length) return 0;
  const indexA = rankMapFromOrder(orderA);
  const indexB = rankMapFromOrder(orderB);
  const items = [...orderA];

  let concordant = 0;
  let discordant = 0;

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i]!;
      const right = items[j]!;
      const deltaA = indexA[left]! - indexA[right]!;
      const deltaB = indexB[left]! - indexB[right]!;
      const sameDirection = deltaA * deltaB > 0;
      if (sameDirection) concordant += 1;
      else discordant += 1;
    }
  }

  const pairs = (items.length * (items.length - 1)) / 2;
  if (pairs === 0) return 0;
  return (concordant - discordant) / pairs;
}

export interface RankRow {
  evaluator: string;
  order: string[];
  rankMap: Record<string, number>;
}

export interface MatrixRow {
  evaluator: string;
  ranks: number[];
}

export interface ConsensusData {
  matrix: MatrixRow[];
  candidateModels: string[];
  consensusScore: number;
  rankOrders: RankRow[];
  labelToModel: Record<string, string>;
}

export function buildConsensusData(
  stage1: StageResult[] = [],
  stage2: RankingResult[] = [],
  metadata: Partial<CouncilMetadata> = {}
): ConsensusData {
  const labelToModel = metadata.label_to_model || parseLabelToModelFallback(stage1);
  const candidateModels = stage1.map((item) => item.model);

  const rows: RankRow[] = stage2.map((entry) => {
    const order = normalizedOrderFromParsed(
      entry.parsed_ranking || [],
      labelToModel,
      candidateModels
    );
    const rankMap = rankMapFromOrder(order);
    return {
      evaluator: entry.model,
      order,
      rankMap,
    };
  });

  let consensusScore = 0;
  if (rows.length >= 2 && candidateModels.length >= 2) {
    let sum = 0;
    let pairs = 0;
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const tau = kendallTau(rows[i]!.order, rows[j]!.order);
        sum += (tau + 1) / 2;
        pairs += 1;
      }
    }
    consensusScore = pairs > 0 ? sum / pairs : 0;
  }

  const matrix: MatrixRow[] = rows.map((row) => ({
    evaluator: row.evaluator,
    ranks: candidateModels.map((model) => row.rankMap[model] || candidateModels.length),
  }));

  return {
    matrix,
    candidateModels,
    consensusScore,
    rankOrders: rows,
    labelToModel,
  };
}

export interface InfluenceEdge {
  from: string;
  to: string;
  weight: number;
}

export interface InfluenceData {
  stage1Models: string[];
  evaluators: string[];
  finalModel: string;
  stage1ToStage2: InfluenceEdge[];
  stage2ToFinal: InfluenceEdge[];
}

export function buildInfluenceData(
  stage1: StageResult[] = [],
  stage2: RankingResult[] = [],
  stage3: FinalResult | null = null,
  metadata: Partial<CouncilMetadata> = {},
  consensusData: ConsensusData | null = null
): InfluenceData {
  const consensus = consensusData || buildConsensusData(stage1, stage2, metadata);
  const stage1Models = stage1.map((item) => item.model);
  const evaluators = stage2.map((item) => item.model);
  const aggregate = metadata.aggregate_rankings || [];

  const aggregateOrder = aggregate.length
    ? aggregate.map((item) => item.model)
    : stage1Models;

  const stage1ToStage2: InfluenceEdge[] = [];
  for (const rankRow of consensus.rankOrders) {
    const total = rankRow.order.length || 1;
    rankRow.order.forEach((model, index) => {
      stage1ToStage2.push({
        from: model,
        to: rankRow.evaluator,
        weight: (total - index) / total,
      });
    });
  }

  const stage2ToFinal: InfluenceEdge[] = consensus.rankOrders.map((rankRow) => {
    const alignmentTau = kendallTau(rankRow.order, aggregateOrder);
    return {
      from: rankRow.evaluator,
      to: stage3?.model || 'final',
      weight: (alignmentTau + 1) / 2,
    };
  });

  return {
    stage1Models,
    evaluators,
    finalModel: stage3?.model || 'final',
    stage1ToStage2,
    stage2ToFinal,
  };
}

export interface ModelSupport {
  model: string;
  score: number;
  snippet: string;
}

export interface FileSupport {
  filename: string;
  score: number;
  snippet: string;
}

export interface TraceEntry {
  id: number;
  text: string;
  modelSupport: ModelSupport[];
  fileSupport: FileSupport[];
}

export function buildTraceabilityData(
  stage1: StageResult[] = [],
  stage3: FinalResult | null = null,
  userAttachments: AttachmentMetadata[] = []
): TraceEntry[] {
  const paragraphs = (stage3?.response || '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const modelSets = stage1.map((item) => ({
    model: item.model,
    tokens: tokenSet(item.response),
    response: item.response || '',
  }));

  const fileSets = (userAttachments || []).map((attachment) => ({
    filename: attachment.filename,
    tokens: tokenSet(attachment.trace_excerpt || attachment.preview || attachment.filename || ''),
    preview: attachment.preview || '',
    traceExcerpt: attachment.trace_excerpt || '',
  }));

  return paragraphs.map((paragraph, index) => {
    const paragraphTokens = tokenSet(paragraph);

    const modelSupport: ModelSupport[] = modelSets
      .map((entry) => ({
        model: entry.model,
        score: jaccard(paragraphTokens, entry.tokens),
        snippet: (entry.response || '').slice(0, 180),
      }))
      .filter((entry) => entry.score >= 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    const fileSupport: FileSupport[] = fileSets
      .map((entry) => {
        const filenameBase = (entry.filename || '').toLowerCase();
        const paragraphLower = paragraph.toLowerCase();
        const mentionBonus = filenameBase && paragraphLower.includes(filenameBase) ? 0.2 : 0;
        return {
          filename: entry.filename,
          score: jaccard(paragraphTokens, entry.tokens) + mentionBonus,
          snippet: entry.preview || entry.traceExcerpt.slice(0, 180),
        };
      })
      .filter((entry) => entry.score >= 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    return {
      id: index + 1,
      text: paragraph,
      modelSupport,
      fileSupport,
    };
  });
}

export interface DiffData {
  shared: string[];
  leftOnly: string[];
  rightOnly: string[];
}

export function buildDiffData(
  stage1: StageResult[] = [],
  leftModel: string = '',
  rightModel: string = ''
): DiffData {
  const left = stage1.find((entry) => entry.model === leftModel)?.response || '';
  const right = stage1.find((entry) => entry.model === rightModel)?.response || '';

  const splitSentences = (text: string) =>
    text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  const leftSentences = splitSentences(left);
  const rightSentences = splitSentences(right);

  const rightIndex = new Map(rightSentences.map((sentence) => [normalize(sentence), sentence]));
  const leftIndex = new Map(leftSentences.map((sentence) => [normalize(sentence), sentence]));

  const shared = leftSentences.filter((sentence) => rightIndex.has(normalize(sentence)));
  const leftOnly = leftSentences.filter((sentence) => !rightIndex.has(normalize(sentence)));
  const rightOnly = rightSentences.filter((sentence) => !leftIndex.has(normalize(sentence)));

  return { shared, leftOnly, rightOnly };
}

export interface Hotspot {
  token: string;
  ratio: number;
  distance: number;
}

export interface UncertaintyData {
  confidenceScore: number;
  consensusScore: number;
  rankSpread: number;
  successRate: number;
  hotspots: Hotspot[];
  openQuestions: string[];
}

export function buildUncertaintyData(
  stage1: StageResult[] = [],
  stage2: RankingResult[] = [],
  stage3: FinalResult | null = null,
  metadata: Partial<CouncilMetadata> = {},
  consensusData: ConsensusData | null = null
): UncertaintyData {
  const consensus = consensusData || buildConsensusData(stage1, stage2, metadata);
  const aggregate = metadata.aggregate_rankings || [];
  const failedModels = metadata.failed_models || [];

  const aggregateRanks = aggregate.map((entry) => entry.average_rank);
  const meanRank = aggregateRanks.length
    ? aggregateRanks.reduce((acc, value) => acc + value, 0) / aggregateRanks.length
    : 0;
  const variance = aggregateRanks.length
    ? aggregateRanks.reduce((acc, value) => acc + ((value - meanRank) ** 2), 0) / aggregateRanks.length
    : 0;
  const stdDev = Math.sqrt(variance);

  const successRate = stage1.length + failedModels.length > 0
    ? stage1.length / (stage1.length + failedModels.length)
    : 1;

  const spreadPenalty = Math.min(1, stdDev / Math.max(1, stage1.length / 2 || 1));
  const confidenceScore = Math.max(0, Math.min(
    100,
    Math.round((consensus.consensusScore * 0.6 + (1 - spreadPenalty) * 0.3 + successRate * 0.1) * 100)
  ));

  const tokenPresence: Record<string, number> = {};
  for (const response of stage1) {
    const seenInModel = new Set(tokenize(response.response));
    for (const token of seenInModel) {
      tokenPresence[token] = (tokenPresence[token] || 0) + 1;
    }
  }

  const hotspots: Hotspot[] = Object.entries(tokenPresence)
    .map(([token, count]) => {
      const ratio = stage1.length > 0 ? count / stage1.length : 0;
      return { token, ratio, distance: Math.abs(0.5 - ratio) };
    })
    .filter((entry) => entry.ratio > 0.15 && entry.ratio < 0.85)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 8);

  const openQuestionPattern = /\?|\b(unclear|depends|unknown|insufficient|cannot determine|not enough information)\b/i;
  const openQuestions = (stage3?.response || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((sentence) => sentence && openQuestionPattern.test(sentence))
    .slice(0, 5);

  return {
    confidenceScore,
    consensusScore: Math.round(consensus.consensusScore * 100),
    rankSpread: Number(stdDev.toFixed(2)),
    successRate: Math.round(successRate * 100),
    hotspots,
    openQuestions,
  };
}

export interface CostLatencyRow {
  stage: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencySeconds: number | null;
}

export interface UsageTotals {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface CostLatencyData {
  rows: CostLatencyRow[];
  totals: UsageTotals;
  stageTiming: Partial<Record<string, number>>;
  failedModels: string[];
}

export function buildCostLatencyRows(
  stage1: StageResult[] = [],
  stage2: RankingResult[] = [],
  stage3: FinalResult | null = null,
  metadata: Partial<CouncilMetadata> = {}
): CostLatencyData {
  const rows: CostLatencyRow[] = [];

  const usageTotals: UsageTotals = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  const addUsage = (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {}) => {
    usageTotals.prompt_tokens += usage.prompt_tokens || 0;
    usageTotals.completion_tokens += usage.completion_tokens || 0;
    usageTotals.total_tokens += usage.total_tokens || 0;
  };

  for (const item of stage1) {
    addUsage(item.usage || {});
    rows.push({
      stage: 'Stage 1',
      model: item.model,
      promptTokens: item.usage?.prompt_tokens || 0,
      completionTokens: item.usage?.completion_tokens || 0,
      totalTokens: item.usage?.total_tokens || 0,
      latencySeconds: item.latency_seconds ?? null,
    });
  }

  for (const item of stage2) {
    addUsage(item.usage || {});
    rows.push({
      stage: 'Stage 2',
      model: item.model,
      promptTokens: item.usage?.prompt_tokens || 0,
      completionTokens: item.usage?.completion_tokens || 0,
      totalTokens: item.usage?.total_tokens || 0,
      latencySeconds: item.latency_seconds ?? null,
    });
  }

  if (stage3) {
    addUsage(stage3.usage || {});
    rows.push({
      stage: 'Stage 3',
      model: stage3.model,
      promptTokens: stage3.usage?.prompt_tokens || 0,
      completionTokens: stage3.usage?.completion_tokens || 0,
      totalTokens: stage3.usage?.total_tokens || 0,
      latencySeconds: stage3.latency_seconds ?? null,
    });
  }

  return {
    rows,
    totals: usageTotals,
    stageTiming: (metadata.timing as Partial<Record<string, number>>) || {},
    failedModels: metadata.failed_models || [],
  };
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value || 0);
}

export function modelLabel(model: string): string {
  return shortModel(model);
}
