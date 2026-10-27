import { historyPlugin } from "./builtin/history/index.js";
import { chromeExtensionsPlugin } from "./chrome/index.js";
import type { BrowserPlugin } from "./contract.js";

// The only feature-specific assembly point. Never import downloaded Node modules here.
export const browserPlugins: readonly BrowserPlugin[] = [
  historyPlugin,
  chromeExtensionsPlugin,
];
