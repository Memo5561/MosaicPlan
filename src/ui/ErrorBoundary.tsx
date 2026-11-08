import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { TFunc } from '../i18n';
import './css/w1-review-fixes.css';

interface Props {
  /** Übersetzung; ohne (außerhalb des Sprachkontexts) erscheint der deutsche Text */
  t?: TFunc;
  /**
   * Äußerste Fehlergrenze (um die ganze App): „Zur Startseite“ lädt die Seite neu. Innere Grenzen
   * werden über ihren `key` (Ansicht) ersetzt, sobald sich die Adresse ändert.
   */
  reloadOnHome?: boolean;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

const FALLBACK: Record<string, string> = {
  'crash.title': 'Diese Ansicht konnte nicht angezeigt werden',
  'crash.text':
    'Beim Anzeigen ist ein unerwarteter Fehler aufgetreten. Ihre Projekte und Materialien liegen im Gerätespeicher; was bis eben gespeichert war, bleibt erhalten. Laden Sie die Seite neu oder gehen Sie zur Startseite.',
  'crash.reload': 'Neu laden',
  'crash.home': 'Zur Startseite',
  'crash.details': 'Technische Angaben',
};

/**
 * Fängt Fehler beim Rendern ab, damit nicht die ganze App weiß wird (React entfernt sonst den
 * gesamten Baum). Beim Abfangen wird der betroffene Teilbaum entfernt – dabei speichern die
 * Projektansichten ausstehende Änderungen (siehe useProject).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Darstellungsfehler', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const t = (k: string) => {
      const v = this.props.t?.(k);
      return v && v !== k ? v : FALLBACK[k];
    };
    return (
      <div className="w1fx-crash" role="alert" data-testid="app-crash">
        <h2>{t('crash.title')}</h2>
        <p>{t('crash.text')}</p>
        <div className="btn-row">
          <button className="btn primary" onClick={() => location.reload()}>
            {t('crash.reload')}
          </button>
          <button
            className="btn"
            onClick={() => {
              // Nicht selbst zurücksetzen: die fehlerhafte Ansicht würde sofort wieder gezeigt (und
              // setzte ihre Adresse zurück). Die App ersetzt diese Fehlergrenze beim Adresswechsel.
              location.hash = '#/';
              if (this.props.reloadOnHome) location.reload();
            }}
          >
            {t('crash.home')}
          </button>
        </div>
        <details>
          <summary>{t('crash.details')}</summary>
          <pre>{`${error.name}: ${error.message}`}</pre>
        </details>
      </div>
    );
  }
}
