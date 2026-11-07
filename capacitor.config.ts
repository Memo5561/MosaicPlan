import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'de.mosaicplan.app',
  appName: 'MosaicPlan',
  webDir: 'dist',
  android: { allowMixedContent: false },
};

export default config;
