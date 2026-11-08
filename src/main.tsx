import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/styles.css';
import { installBackButton, installSystemBars, isNative } from './platform';
import { modalDepth } from './ui/modalHistory';
import { announceNotice, SaveResultHost } from './ui/SaveResultNote';

declare global {
  interface Window {
    /** gesetzt vom Funktionstest in index.html, wenn dieser Browser bzw. diese WebView zu alt ist */
    __mpUnsupported?: string;
    /** gesetzt von MainActivity (APK), nachdem die abgestürzte Anzeige neu gestartet wurde */
    __mpRendererRecovered?: boolean;
  }
}

function start() {
  // Offline-Service-Worker nur im Browser; in der Android-App liegen alle Dateien ohnehin lokal.
  if (!isNative() && 'serviceWorker' in navigator) {
    import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
  }

  if (isNative()) {
    // Zurück-Taste: Dialog schließen → vorheriger Schritt → Startseite → App minimieren (nie beenden)
    installBackButton(() => modalDepth(history.state) > 0);
    // Lesbare Symbole in Status- und Navigationsleiste
    installSystemBars();
    // Nach einem Absturz der Anzeige (z. B. Speichermangel) hat MainActivity neu gestartet: ehrlich sagen
    const recovered = () => announceNotice('filesave.recovered');
    if (window.__mpRendererRecovered) recovered();
    window.addEventListener('mp-renderer-recovered', recovered);
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary reloadOnHome>
        <App />
      </ErrorBoundary>
      {/* Meldungen „gespeichert unter …“ / „nicht gespeichert – teilen“ (APK) */}
      <ErrorBoundary>
        <SaveResultHost />
      </ErrorBoundary>
    </StrictMode>,
  );
}

// Zu alter Browser/WebView: index.html zeigt bereits die Erklärung – nicht überschreiben.
if (window.__mpUnsupported) console.warn('MosaicPlan: nicht unterstützt –', window.__mpUnsupported);
else start();
