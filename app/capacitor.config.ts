import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'com.runweave.app',
  appName: 'Runweave',
  webDir: 'dist',
  plugins: {
    Keyboard: {
      resize: KeyboardResize.Native,
    },
  },
};

export default config;
