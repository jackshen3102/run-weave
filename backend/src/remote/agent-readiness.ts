import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RemoteCapabilities } from "@runweave/shared/remote";

type Agent = NonNullable<RemoteCapabilities["agents"]>[number];
let cached: { expiresAt: number; agents: Agent[] } | null = null;

function probe(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000, maxBuffer: 16_384 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}\n${stderr}`.trim() });
    });
  });
}

async function pi(): Promise<Agent> {
  const version = await probe("pi", ["--version"]);
  if (!version.ok) return { kind: "pi", state: "missing_cli", version: null, provider: null, model: null };
  let provider: string | null = null;
  let model: string | null = null;
  try {
    const settings = JSON.parse(await readFile(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json"), "utf8")) as { defaultProvider?: unknown; defaultModel?: unknown };
    provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider : null;
    model = typeof settings.defaultModel === "string" ? settings.defaultModel : null;
  } catch { /* Missing settings are reported as a separate preparation step. */ }
  const versionLabel = version.output.split("\n")[0]?.slice(0, 120) ?? null;
  if (!provider || !model) return { kind: "pi", state: "needs_configuration", version: versionLabel, provider, model };
  const auth = await probe("pi", ["auth", "check", "--provider", provider, "--model", model, "--json"]);
  let ready = false;
  if (auth.ok) {
    try { ready = (JSON.parse(auth.output) as { status?: unknown }).status === "ready"; } catch { /* Malformed status is not authentication proof. */ }
  }
  return { kind: "pi", state: ready ? "ready" : "needs_auth", version: versionLabel, provider, model };
}

async function codex(): Promise<Agent> {
  const version = await probe("codex", ["--version"]);
  if (!version.ok) return { kind: "codex", state: "missing_cli", version: null, provider: null, model: null };
  const auth = await probe("codex", ["login", "status"]);
  return { kind: "codex", state: auth.ok ? "ready" : "needs_auth", version: version.output.split("\n")[0]?.slice(0, 120) ?? null, provider: null, model: null };
}

export async function getRemoteAgentReadiness(): Promise<Agent[]> {
  if (cached && cached.expiresAt > Date.now()) return cached.agents;
  const agents = await Promise.all([pi(), codex()]);
  cached = { expiresAt: Date.now() + 30_000, agents };
  return agents;
}
