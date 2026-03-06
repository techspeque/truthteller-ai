import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { log } from '@/lib/logger';
import type { StageResult } from '@/types/api';
import './Stage1.css';

interface Stage1Props {
  responses: StageResult[];
  failedModels?: string[];
  failedModelErrors?: Record<string, string>;
}

export default function Stage1({ responses, failedModels, failedModelErrors }: Stage1Props) {
  const [activeTab, setActiveTab] = useState(0);
  const [copied, setCopied] = useState(false);

  const hasResponses = Array.isArray(responses) && responses.length > 0;

  const handleCopy = async () => {
    if (!hasResponses) return;
    try {
      await navigator.clipboard.writeText(responses[activeTab]!.response);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      log.warn('Clipboard copy failed', { error: (e as Error).message });
    }
  };

  const successfulModels = new Set((responses || []).map((r) => r.model));
  const failed = (failedModels || []).filter((m) => !successfulModels.has(m));
  const errorMap = failedModelErrors || {};

  if (!hasResponses && failed.length === 0) {
    return null;
  }

  return (
    <div className="stage stage1">
      <h3 className="stage-title">Stage 1: Individual Responses</h3>

      {hasResponses && (
        <div className="tabs">
          {responses.map((resp, index) => (
            <button
              key={index}
              className={`tab ${activeTab === index ? 'active' : ''}`}
              onClick={() => setActiveTab(index)}
            >
              {resp.model.split('/')[1] || resp.model}
            </button>
          ))}
          {failed.map((model) => (
            <button key={model} className="tab tab-failed" disabled>
              {model.split('/')[1] || model} (failed)
            </button>
          ))}
        </div>
      )}

      {failed.length > 0 && (
        <div className="failed-details">
          {failed.map((model) => (
            <div key={`${model}-error`} className="failed-detail-row">
              <span className="failed-model-name">{model}</span>
              <span className="failed-model-reason">{errorMap[model] || 'Unknown model failure'}</span>
            </div>
          ))}
        </div>
      )}

      {hasResponses && (
        <div className="tab-content">
          <div className="tab-content-header">
            <div className="model-name">
              {responses[activeTab]!.model}
              {responses[activeTab]!.usage && (
                <span className="token-badge">
                  {responses[activeTab]!.usage!.total_tokens} tokens
                </span>
              )}
            </div>
            <button className="copy-btn" onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="response-text markdown-content">
            <ReactMarkdown>{responses[activeTab]!.response}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
