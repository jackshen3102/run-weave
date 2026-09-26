/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_CLARITY_ENABLED?: string;
  readonly VITE_CLARITY_PROJECT_ID?: string;
}
