import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'de.mosaicplan.app',
  appName: 'MosaicPlan',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    // Das Bundle ist für Chrome 111+ gebaut (vite.config.ts build.target). Ältere WebViews bekommen statt
    // einer leeren Seite die Hinweisseite public/webview-update.html (Capacitor: server.errorPath).
    minWebViewVersion: 111,
  },
  server: {
    // auch bei Ladefehlern der Startseite; die Seite unterscheidet „zu alt“ und „Ladefehler“ selbst
    errorPath: 'webview-update.html',
  },
  plugins: {
    // index.html setzt viewport-fit=cover: so bekommt schon das erste Layout die Systemleisten-Abstände
    SystemBars: { initialViewportFitValueHint: 'cover' },
  },
};

export default config;
