/// <reference types="astro/client" />
interface ImportMetaEnv {
  readonly WEBSITE_PRODUCTION: boolean;
  readonly WEBSITE_CLARITY_ENABLED: boolean;
  readonly WEBSITE_CLARITY_PROJECT_ID: string;
}
