import type { ReactNode } from 'react';
import '../css/w2-workspace-shell.css';

export interface EmptyAction {
  label: ReactNode;
  onClick: () => void;
  primary?: boolean;
  testId?: string;
}

/**
 * Leerer Zustand eines Schritts: sagt, warum hier (noch) nichts ist, und bietet die echte nächste
 * Handlung als Schaltfläche an. `compact` für einen Hinweis über einem trotzdem nutzbaren Schritt.
 */
export function EmptyState(props: { icon?: ReactNode; title: ReactNode; text?: ReactNode; actions?: EmptyAction[]; compact?: boolean; tone?: 'info' | 'error'; testId?: string }) {
  const { icon, title, text, actions = [], compact, tone = 'info', testId } = props;
  return (
    <div className={`w2ws-empty ${compact ? 'w2ws-empty-compact' : ''} w2ws-empty-${tone}`} data-testid={testId} role={tone === 'error' ? 'alert' : undefined}>
      {icon && (
        <div className="w2ws-empty-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="w2ws-empty-main">
        <h3 className="w2ws-empty-title">{title}</h3>
        {text && <p className="w2ws-empty-text">{text}</p>}
        {actions.length > 0 && (
          <div className="btn-row w2ws-empty-actions">
            {actions.map((a, i) => (
              <button key={i} type="button" className={`btn ${a.primary ? 'primary' : ''}`} onClick={a.onClick} data-testid={a.testId}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
