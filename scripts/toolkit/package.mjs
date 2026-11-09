import { chmodSync, cpSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildAgentAssets } from "../agents/build.mjs";
import { toolkitRelease } from "./release.mjs";

/** Build once at publication; installation needs only Node and the Agent CLI. */
export async function packageToolkit(repo, payload) {
  await buildAgentAssets();
  const release = toolkitRelease(repo);
  for (const file of release.files) {
    const target = path.join(payload, "plugins/toolkit", file.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, { mode: file.mode });
    chmodSync(target, file.mode);
  }
  for (const relative of [
    ".agents/plugins/marketplace.json",
    "scripts/toolkit/sync.mjs",
    "scripts/toolkit/sync-runtime.mjs",
    "scripts/toolkit/release.mjs",
    "scripts/toolkit/codex-state.mjs",
    "packages/agent-bridge/src/install-pi.mjs",
    "plugins/pi/dist",
  ]) {
    const target = path.join(payload, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(repo, relative), target, { recursive: true });
  }
  writeFileSync(path.join(payload, "plugins/toolkit-release.json"),
    JSON.stringify({ version: release.version, digest: release.digest }) + "\n");
}
