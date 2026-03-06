import { useMemo, useState } from 'react';
import {
  buildConsensusData,
  buildInfluenceData,
  buildTraceabilityData,
  buildDiffData,
  buildUncertaintyData,
  buildCostLatencyRows,
  formatNumber,
  modelLabel,
} from '@/utils/insights';
import type { AssistantMessage, UserMessage } from '@/types/api';
import './CouncilInsights.css';

const EMPTY_ARRAY: never[] = [];
const EMPTY_OBJECT: Partial<import('@/types/api').CouncilMetadata> = {};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function heatColor(rank: number, total: number) {
  const normalized = total <= 1 ? 0 : (rank - 1) / (total - 1);
  const hue = 120 - (normalized * 120);
  const saturation = 70;
  const lightness = 42;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function graphModelLabel(model: string, maxLength = 22) {
  const label = modelLabel(model);
  if (label.length <= maxLength) return label;
  return `${label.slice(0, maxLength - 3)}...`;
}

interface CouncilInsightsProps {
  assistantMessage: AssistantMessage;
  userMessage: UserMessage | null;
  assistantIndex: number;
  onRerunAssistant: (assistantIndex: number, options: { stage: string; includeModels: string[]; chairmanModel: string }) => void;
  isBusy: boolean;
}

export default function CouncilInsights({
  assistantMessage,
  userMessage,
  assistantIndex,
  onRerunAssistant,
  isBusy,
}: CouncilInsightsProps) {
  const stage1 = assistantMessage?.stage1 || EMPTY_ARRAY;
  const stage2 = assistantMessage?.stage2 || EMPTY_ARRAY;
  const stage3 = assistantMessage?.stage3 || null;
  const metadata = assistantMessage?.metadata || EMPTY_OBJECT;
  const userAttachments = userMessage?.attachments || EMPTY_ARRAY;

  const modelOptions = useMemo(() => stage1.map((entry) => entry.model), [stage1]);

  const [leftModel, setLeftModel] = useState(() => modelOptions[0] || '');
  const [rightModel, setRightModel] = useState(() => modelOptions[1] || modelOptions[0] || '');
  const [selectedModels, setSelectedModels] = useState(() => modelOptions);
  const [chairmanModel, setChairmanModel] = useState(() => stage3?.model || modelOptions[0] || '');
  const effectiveLeftModel = modelOptions.includes(leftModel) ? leftModel : (modelOptions[0] || '');
  const fallbackRight = modelOptions[1] || modelOptions[0] || '';
  const effectiveRightModel = modelOptions.includes(rightModel) ? rightModel : fallbackRight;
  const filteredSelectedModels = selectedModels.filter((model) => modelOptions.includes(model));
  const effectiveSelectedModels = filteredSelectedModels.length > 0 ? filteredSelectedModels : modelOptions;
  const effectiveChairmanModel = modelOptions.includes(chairmanModel)
    ? chairmanModel
    : (stage3?.model && modelOptions.includes(stage3.model) ? stage3.model : modelOptions[0] || '');

  const consensusData = useMemo(
    () => buildConsensusData(stage1, stage2, metadata),
    [stage1, stage2, metadata]
  );
  const influenceData = useMemo(
    () => buildInfluenceData(stage1, stage2, stage3, metadata, consensusData),
    [stage1, stage2, stage3, metadata, consensusData]
  );
  const traceability = useMemo(
    () => buildTraceabilityData(stage1, stage3, userAttachments),
    [stage1, stage3, userAttachments]
  );
  const diffData = useMemo(
    () => buildDiffData(stage1, effectiveLeftModel, effectiveRightModel),
    [stage1, effectiveLeftModel, effectiveRightModel]
  );
  const uncertainty = useMemo(
    () => buildUncertaintyData(stage1, stage2, stage3, metadata, consensusData),
    [stage1, stage2, stage3, metadata, consensusData]
  );
  const costLatency = useMemo(
    () => buildCostLatencyRows(stage1, stage2, stage3, metadata),
    [stage1, stage2, stage3, metadata]
  );

  const toggleModelSelection = (model: string) => {
    setSelectedModels((prev) => {
      if (prev.includes(model)) return prev.filter((entry) => entry !== model);
      return [...prev, model];
    });
  };

  const runRerun = async (stage: string) => {
    await onRerunAssistant(assistantIndex, {
      stage,
      includeModels: effectiveSelectedModels,
      chairmanModel: effectiveChairmanModel,
    });
  };

  if (!stage3) {
    return null;
  }

  const totalCandidates = Math.max(1, consensusData.candidateModels.length);

  const allGraphNodes = Math.max(
    influenceData.stage1Models.length,
    influenceData.evaluators.length,
    1
  );
  const graphHeight = allGraphNodes * 64 + 82;
  const graphWidth = 980;
  const stage1NodeX = 220;
  const stage2NodeX = 500;
  const stage3NodeX = 800;
  const stage1LabelX = stage1NodeX - 18;
  const stage2LabelX = stage2NodeX + 18;
  const stage3LabelX = stage3NodeX + 18;

  const stage1Positions: Record<string, number> = Object.fromEntries(
    influenceData.stage1Models.map((model, index) => [model, 52 + (index * 64)])
  );
  const stage2Positions: Record<string, number> = Object.fromEntries(
    influenceData.evaluators.map((model, index) => [model, 52 + (index * 64)])
  );
  const finalY = Math.round(graphHeight / 2);

  return (
    <div className="insights-root">
      <div className="insight-card">
        <div className="insight-header">
          <h4>Consensus Matrix</h4>
          <span className="insight-pill">Consensus {Math.round(consensusData.consensusScore * 100)}%</span>
        </div>
        {consensusData.matrix.length === 0 ? (
          <p className="insight-empty">No ranking matrix available for this response.</p>
        ) : (
          <div className="matrix-wrap">
            <table className="consensus-matrix">
              <thead>
                <tr>
                  <th>Evaluator</th>
                  {consensusData.candidateModels.map((model) => (
                    <th key={model}>{modelLabel(model)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {consensusData.matrix.map((row) => (
                  <tr key={row.evaluator}>
                    <td>{modelLabel(row.evaluator)}</td>
                    {row.ranks.map((rank, idx) => (
                      <td key={`${row.evaluator}-${idx}`}>
                        <span
                          className="rank-cell"
                          style={{
                            background: heatColor(rank, totalCandidates),
                            opacity: clamp(1 - ((rank - 1) / Math.max(1, totalCandidates - 1)) * 0.65, 0.35, 1),
                          }}
                        >
                          {rank}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="insight-card">
        <div className="insight-header">
          <h4>Influence Graph</h4>
          <span className="insight-muted">Stage 1 to Stage 2 to Final</span>
        </div>
        <svg className="influence-graph" viewBox={`0 0 ${graphWidth} ${graphHeight}`}>
          <text x={stage1NodeX - 10} y="24" className="graph-label" textAnchor="end">Stage 1</text>
          <text x={stage2NodeX - 10} y="24" className="graph-label" textAnchor="end">Stage 2</text>
          <text x={stage3NodeX - 10} y="24" className="graph-label" textAnchor="end">Stage 3</text>

          {influenceData.stage1ToStage2.map((edge, index) => (
            <line
              key={`s1-s2-${index}`}
              x1={stage1NodeX + 10}
              y1={stage1Positions[edge.from] || 52}
              x2={stage2NodeX - 10}
              y2={stage2Positions[edge.to] || 52}
              stroke="var(--border-accent)"
              strokeWidth={1 + (edge.weight * 2)}
              strokeOpacity={0.2 + (edge.weight * 0.55)}
            />
          ))}

          {influenceData.stage2ToFinal.map((edge, index) => (
            <line
              key={`s2-s3-${index}`}
              x1={stage2NodeX + 10}
              y1={stage2Positions[edge.from] || 52}
              x2={stage3NodeX - 10}
              y2={finalY}
              stroke="var(--text-success)"
              strokeWidth={1 + (edge.weight * 3)}
              strokeOpacity={0.25 + (edge.weight * 0.65)}
            />
          ))}

          {influenceData.stage1Models.map((model) => (
            <g key={`s1-node-${model}`}>
              <title>{model}</title>
              <circle cx={stage1NodeX} cy={stage1Positions[model]} r="10" className="graph-node stage1" />
              <text
                x={stage1LabelX}
                y={(stage1Positions[model] || 52) + 4}
                className="graph-node-label"
                textAnchor="end"
              >
                {graphModelLabel(model)}
              </text>
            </g>
          ))}

          {influenceData.evaluators.map((model) => (
            <g key={`s2-node-${model}`}>
              <title>{model}</title>
              <circle cx={stage2NodeX} cy={stage2Positions[model]} r="10" className="graph-node stage2" />
              <text x={stage2LabelX} y={(stage2Positions[model] || 52) + 4} className="graph-node-label">
                {graphModelLabel(model)}
              </text>
            </g>
          ))}

          <g>
            <title>{influenceData.finalModel}</title>
            <circle cx={stage3NodeX} cy={finalY} r="12" className="graph-node stage3" />
            <text x={stage3LabelX} y={finalY + 4} className="graph-node-label">
              {graphModelLabel(influenceData.finalModel)}
            </text>
          </g>
        </svg>
      </div>

      <div className="insight-card">
        <div className="insight-header">
          <h4>Final Answer Traceability</h4>
          <span className="insight-muted">Paragraph-level source support</span>
        </div>
        {traceability.length === 0 ? (
          <p className="insight-empty">No final paragraphs available for traceability mapping.</p>
        ) : (
          <div className="trace-list">
            {traceability.map((entry) => (
              <details key={entry.id} className="trace-item" open={entry.id === 1}>
                <summary>
                  Paragraph {entry.id}
                  <span className="trace-chip-row">
                    {entry.modelSupport.map((support) => (
                      <span key={`${entry.id}-${support.model}`} className="trace-chip model">
                        {modelLabel(support.model)} ({Math.round(support.score * 100)}%)
                      </span>
                    ))}
                    {entry.fileSupport.map((support) => (
                      <span key={`${entry.id}-${support.filename}`} className="trace-chip file">
                        {support.filename}
                      </span>
                    ))}
                  </span>
                </summary>
                <p>{entry.text}</p>
                {(entry.modelSupport.length > 0 || entry.fileSupport.length > 0) && (
                  <div className="trace-sources">
                    {entry.modelSupport.map((support) => (
                      <div key={`model-source-${entry.id}-${support.model}`} className="trace-source">
                        <strong>{modelLabel(support.model)}</strong>: {support.snippet}
                      </div>
                    ))}
                    {entry.fileSupport.map((support) => (
                      <div key={`file-source-${entry.id}-${support.filename}`} className="trace-source">
                        <strong>{support.filename}</strong>: {support.snippet || 'Referenced in paragraph'}
                      </div>
                    ))}
                  </div>
                )}
              </details>
            ))}
          </div>
        )}
      </div>

      <div className="insight-card">
        <div className="insight-header">
          <h4>Side-by-Side Diff</h4>
          <span className="insight-muted">Highlighting disagreement between model outputs</span>
        </div>

        <div className="diff-controls">
          <label>
            Left
            <select value={effectiveLeftModel} onChange={(e) => setLeftModel(e.target.value)}>
              {modelOptions.map((model) => (
                <option key={`left-${model}`} value={model}>{modelLabel(model)}</option>
              ))}
            </select>
          </label>
          <label>
            Right
            <select value={effectiveRightModel} onChange={(e) => setRightModel(e.target.value)}>
              {modelOptions.map((model) => (
                <option key={`right-${model}`} value={model}>{modelLabel(model)}</option>
              ))}
            </select>
          </label>
          <div className="diff-shared">Shared claims: {diffData.shared.length}</div>
        </div>

        <div className="diff-grid">
          <div>
            <h5>{modelLabel(effectiveLeftModel)} unique claims</h5>
            <ul>
              {diffData.leftOnly.slice(0, 8).map((sentence, idx) => (
                <li key={`left-only-${idx}`}>{sentence}</li>
              ))}
            </ul>
          </div>
          <div>
            <h5>{modelLabel(effectiveRightModel)} unique claims</h5>
            <ul>
              {diffData.rightOnly.slice(0, 8).map((sentence, idx) => (
                <li key={`right-only-${idx}`}>{sentence}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="insight-card">
        <div className="insight-header">
          <h4>Uncertainty Panel</h4>
          <span className="insight-pill">Confidence {uncertainty.confidenceScore}%</span>
        </div>

        <div className="uncertainty-metrics">
          <div><strong>{uncertainty.consensusScore}%</strong><span>Ranking consensus</span></div>
          <div><strong>{uncertainty.rankSpread}</strong><span>Rank spread</span></div>
          <div><strong>{uncertainty.successRate}%</strong><span>Model success rate</span></div>
        </div>

        <h5>Disagreement Hotspots</h5>
        <div className="hotspot-row">
          {uncertainty.hotspots.length === 0 ? (
            <span className="insight-empty">No strong hotspots detected.</span>
          ) : (
            uncertainty.hotspots.map((hotspot) => (
              <span key={hotspot.token} className="hotspot-chip">
                {hotspot.token}
              </span>
            ))
          )}
        </div>

        <h5>Open Questions</h5>
        {uncertainty.openQuestions.length === 0 ? (
          <p className="insight-empty">No explicit unresolved questions detected in final answer.</p>
        ) : (
          <ul className="open-question-list">
            {uncertainty.openQuestions.map((question, index) => (
              <li key={`open-q-${index}`}>{question}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="insight-card">
        <div className="insight-header">
          <h4>Cost & Latency Breakdown</h4>
          <span className="insight-muted">Per model and stage</span>
        </div>

        <div className="timing-row">
          <span>Stage 1: {metadata?.timing?.stage1 ?? '-'}s</span>
          <span>Stage 2: {metadata?.timing?.stage2 ?? '-'}s</span>
          <span>Stage 3: {metadata?.timing?.stage3 ?? '-'}s</span>
        </div>

        <div className="matrix-wrap">
          <table className="cost-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Model</th>
                <th>Prompt</th>
                <th>Completion</th>
                <th>Total</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {costLatency.rows.map((row, index) => (
                <tr key={`cost-${index}`}>
                  <td>{row.stage}</td>
                  <td>{modelLabel(row.model)}</td>
                  <td>{formatNumber(row.promptTokens)}</td>
                  <td>{formatNumber(row.completionTokens)}</td>
                  <td>{formatNumber(row.totalTokens)}</td>
                  <td>{row.latencySeconds != null ? `${row.latencySeconds}s` : '-'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}>Total</td>
                <td>{formatNumber(costLatency.totals.prompt_tokens)}</td>
                <td>{formatNumber(costLatency.totals.completion_tokens)}</td>
                <td>{formatNumber(costLatency.totals.total_tokens)}</td>
                <td>-</td>
              </tr>
            </tfoot>
          </table>
        </div>

        {costLatency.failedModels.length > 0 && (
          <p className="failed-row">
            Failed models: {costLatency.failedModels.map((model) => modelLabel(model)).join(', ')}
          </p>
        )}
      </div>

      <div className="insight-card rerun-card">
        <div className="insight-header">
          <h4>Interactive Rerun Controls</h4>
          <span className="insight-muted">No file re-upload required</span>
        </div>

        <div className="rerun-grid">
          <div>
            <h5>Included models</h5>
            <div className="model-checks">
              {modelOptions.map((model) => (
                <label key={`rerun-model-${model}`}>
                  <input
                    type="checkbox"
                    checked={filteredSelectedModels.length > 0 ? filteredSelectedModels.includes(model) : true}
                    onChange={() => toggleModelSelection(model)}
                    disabled={isBusy}
                  />
                  {modelLabel(model)}
                </label>
              ))}
            </div>
          </div>

          <div>
            <h5>Chairman override</h5>
            <select
              value={effectiveChairmanModel}
              onChange={(e) => setChairmanModel(e.target.value)}
              disabled={isBusy}
            >
              {modelOptions.map((model) => (
                <option key={`chair-${model}`} value={model}>{model}</option>
              ))}
            </select>
            <div className="rerun-actions">
              <button
                type="button"
                onClick={() => runRerun('stage2')}
                disabled={isBusy || effectiveSelectedModels.length === 0}
              >
                Re-run Stage 2 + 3
              </button>
              <button
                type="button"
                onClick={() => runRerun('stage3')}
                disabled={isBusy || effectiveSelectedModels.length === 0}
              >
                Re-run Stage 3 only
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
