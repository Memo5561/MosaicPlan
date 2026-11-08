import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/styles.css';
import { isNative } from './platform';

// Offline-Service-Worker nur im Browser; in der Android-App liegen alle Dateien ohnehin lokal.
if (!isNative() && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary reloadOnHome>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
