import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { log } from '@/lib/logger';
import './Stage3.css';

export default function Stage3({ finalResponse }) {
  const [copied, setCopied] = useState(false);

  if (!finalResponse) {
    return null;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(finalResponse.response);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      log.warn('Clipboard copy failed', { error: e.message });
    }
  };

  return (
    <div className="stage stage3">
      <h3 className="stage-title">Stage 3: Final Council Answer</h3>
      <div className="final-response">
        <div className="final-response-header">
          <div className="chairman-label">
            Chairman: {finalResponse.model.split('/')[1] || finalResponse.model}
            {finalResponse.usage && (
              <span className="token-badge">
                {finalResponse.usage.total_tokens} tokens
              </span>
            )}
          </div>
          <button className="copy-btn" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div className="final-text markdown-content">
          <ReactMarkdown>{finalResponse.response}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
