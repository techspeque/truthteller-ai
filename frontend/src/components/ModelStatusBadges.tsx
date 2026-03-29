import type { ModelStatusEntry } from '@/types/api';
import './ModelStatusBadges.css';

function shortName(model: string): string {
  const name = model.includes('/') ? model.split('/').pop()! : model;
  return name;
}

interface ModelStatusBadgesProps {
  statuses: ModelStatusEntry[];
}

export default function ModelStatusBadges({ statuses }: ModelStatusBadgesProps) {
  if (!statuses.length) return null;

  return (
    <div className="model-badges">
      {statuses.map((entry) => (
        <span
          key={entry.model}
          className={`model-badge model-badge-${entry.status}`}
          title={entry.error ? `${entry.model}: ${entry.error}` : entry.model}
        >
          <span className="model-badge-dot" />
          {shortName(entry.model)}
        </span>
      ))}
    </div>
  );
}
