import { resolveConfigurationContext } from "@runweave/config-node";

declare const __RUNWEAVE_DEV_SESSION_ID__: string | null;

export function resolveDesktopConfigurationContext() {
  const bundledSession = typeof __RUNWEAVE_DEV_SESSION_ID__ === "undefined" ? null : __RUNWEAVE_DEV_SESSION_ID__;
  return resolveConfigurationContext({
    args: [...process.argv.slice(2), ...(bundledSession ? ["--instance", bundledSession] : [])],
  });
}
