import { existsSync } from "node:fs";
import path from "node:path";
import { commandExists, runResult } from "./sync-runtime.mjs";
import { packageMatches } from "./release.mjs";

export function codexReleaseInstalled(release, { marketplaceName, pluginName, publishRoot, cacheRoot }) {
  if (!commandExists("codex")) return false;
  const result = runResult("codex", [
    "plugin",
    "list",
    "--marketplace",
    marketplaceName,
    "--json",
  ]);
  if (result.status !== 0) return false;
  const installed = JSON.parse(result.stdout).installed?.find(
    (plugin) => plugin.pluginId === `${pluginName}@${marketplaceName}`,
  );
  return (
    installed?.version === release.version &&
    installed?.marketplaceSource?.source === publishRoot &&
    packageMatches(
      path.join(
        cacheRoot,
        release.version,
      ),
      release.files,
    )
  );
}

export function collectSessionReferencedCodexVersions(pluginName, marketplaceName, codexHome) {
  if (!commandExists("rg")) {
    return [];
  }

  const sessionsDir = path.join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const pattern = [
    "plugins/cache",
    marketplaceName,
    pluginName,
    "[0-9]+\\.[0-9]+\\.[0-9]+\\+codex\\.[a-f0-9]+",
  ].join("/");
  const result = runResult(
    "rg",
    [
      "--only-matching",
      "--no-filename",
      "--color",
      "never",
      pattern,
      sessionsDir,
    ],
    { quiet: true },
  );
  if (result.status !== 0 && result.status !== 1) {
    return [];
  }

  const versionPattern = /[0-9]+\.[0-9]+\.[0-9]+\+codex\.[a-f0-9]+/g;
  return Array.from(
    new Set(`${result.stdout || ""}`.match(versionPattern) ?? []),
  );
}

