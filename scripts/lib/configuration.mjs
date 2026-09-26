import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const requireFromBackend = createRequire(new URL("../../backend/package.json", import.meta.url));
export const configurationLibrary = requireFromBackend("tsx/cjs/api").require(
  fileURLToPath(new URL("../../packages/config-node/src/index.ts", import.meta.url)), import.meta.url,
);
export function explicitConfigurationArguments() {
  return configurationLibrary.configurationArguments(configurationLibrary.resolveConfigurationContext({ requireExplicit: true }));
}
