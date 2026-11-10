import os from "node:os";
import { buildCodexProcessEnv, resolveCodexLaunchPlan } from "../voice/codex-app-server-client";
import { resolveClaudeConfiguration } from "@runweave/config-node/claude";
import {
  AGENT_CAPABILITY_NAMES,
  type AgentCapabilitiesResponse, type AgentCapabilityName,
  type AgentCapabilityProvider, type AgentCapabilityReason,
  type AgentCapabilityState, type AgentProviderCapabilities,
} from "@runweave/shared/agent-capabilities";
import type { ScheduledTaskCapabilities } from "@runweave/shared/scheduled-tasks";
import { AgentCapabilityProbe } from "./probe";

const CACHE_MS = 30_000;
const available = (): AgentCapabilityState => ({ status: "available", reason: null });
const unavailable = (reason: AgentCapabilityReason): AgentCapabilityState => ({ status: "unavailable", reason });

// These describe existing integration entry points, NOT target/session readiness.
// An absent adapter is unavailable, not evidence of an upstream limitation.
const ADAPTERS: Record<AgentCapabilityProvider, readonly AgentCapabilityName[]> = {
  codex: ["prepare", "conversation", "resume", "queue", "attachments", "liveSettings", "questions", "fork", "sideChat"],
  trae: ["prepare", "conversation", "resume", "queue", "attachments", "liveSettings"],
  pi: ["prepare", "conversation", "resume", "queue", "attachments"],
  claude: [],
};

export class AgentCapabilitiesService {
  private readonly probe = new AgentCapabilityProbe();
  private readonly env: NodeJS.ProcessEnv;
  private closed = false;
  private cached?: { value: AgentCapabilitiesResponse; expires: number };
  private pending?: Promise<AgentCapabilitiesResponse>;

  constructor(
    private readonly background: () => ScheduledTaskCapabilities,
    env: NodeJS.ProcessEnv = process.env,
  ) { this.env = { ...env }; }

  async getCapabilities(): Promise<AgentCapabilitiesResponse> {
    if (this.closed) return { providers: Object.keys(ADAPTERS).map(provider =>
      this.describe(provider as AgentCapabilityProvider, null, unavailable("service_closed"))) };
    if (this.cached && this.cached.expires > Date.now()) return structuredClone(this.cached.value);
    if (!this.pending) {
      this.pending = this.readProviders().then(value => {
        if (!this.closed) this.cached = { value, expires: Date.now() + CACHE_MS };
        return value;
      }).finally(() => { this.pending = undefined; });
    }
    return structuredClone(await this.pending);
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.cached = undefined;
    const settled = await Promise.allSettled([this.probe.dispose(), this.pending]);
    const failures = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "agent_capabilities_cleanup_failed");
  }

  private async readProviders(): Promise<AgentCapabilitiesResponse> {
    return { providers: await Promise.all((Object.keys(ADAPTERS) as AgentCapabilityProvider[]).map(async provider => {
      if (provider === "claude") return this.readClaude();
      const plan = provider === "pi" ? null : resolveCodexLaunchPlan(this.env, provider === "trae" ? "traex" : "codex");
      const result = await this.probe.run(plan?.command ?? "pi", ["--version"],
        plan ? buildCodexProcessEnv(this.env, plan) : this.env, os.userInfo().homedir);
      const version = result.reason ? null : readVersion(result.stdout);
      return this.describe(provider, version,
        result.reason ? unavailable(result.reason) : version ? available() : unavailable("version_unrecognized"));
    })) };
  }

  private async readClaude(): Promise<AgentProviderCapabilities> {
    let native: ReturnType<typeof resolveClaudeConfiguration>;
    try { native = resolveClaudeConfiguration(this.env); }
    catch { return this.describe("claude", null, unavailable("configuration_invalid")); }
    // The native CLI owns credentials. Only the directory reference is forwarded;
    // no settings/transcript file is read and no login or model call is made.
    const env = { ...this.env, CLAUDE_CONFIG_DIR: native.configDirectory };
    const versionResult = await this.probe.run(native.binary, ["--version"], env, os.userInfo().homedir);
    if (versionResult.reason) return this.describe("claude", null, unavailable(versionResult.reason));
    const version = readVersion(versionResult.stdout);
    if (!version) return this.describe("claude", null, unavailable("version_unrecognized"));
    const auth = await this.probe.run(native.binary, ["auth", "status", "--json"], env, os.userInfo().homedir);
    let state = unavailable(auth.reason && auth.reason !== "probe_failed" ? auth.reason : "authentication_unverified");
    if (!auth.reason || auth.reason === "probe_failed") {
      try {
        const value: unknown = JSON.parse(auth.stdout);
        if (typeof value === "object" && value !== null && "loggedIn" in value) {
          if (value.loggedIn === false) state = unavailable("authentication_required");
          else if (value.loggedIn === true && !auth.reason) state = available();
        }
      } catch { /* Unknown native output cannot establish authentication. */ }
    }
    return this.describe("claude", version, state);
  }

  private describe(provider: AgentCapabilityProvider, version: string | null, availability: AgentCapabilityState): AgentProviderCapabilities {
    const capabilities = Object.fromEntries(AGENT_CAPABILITY_NAMES.map(name => [name,
      provider === "claude" ? unavailable("integration_unverified")
        : !ADAPTERS[provider].includes(name) ? unavailable("integration_unavailable")
          : name === "conversation" ? (this.closed ? unavailable("service_closed") : available())
            : availability.status === "available" ? available() : availability,
    ])) as Record<AgentCapabilityName, AgentCapabilityState>;
    if (provider === "codex") {
      const background = this.background();
      capabilities.background = !this.closed && background.enabled && background.providers.some(item => item.provider === "codex" && item.available)
        ? available() : unavailable("background_unavailable");
      if (process.platform !== "darwin" && process.platform !== "linux") {
        capabilities.sideChat = { status: "unsupported", reason: "platform_unsupported" };
      }
    }
    return { provider, version, availability, capabilities };
  }
}

/** Return only a numeric version, never arbitrary stdout or account identifiers. */
function readVersion(output: string): string | null {
  return output.trim().match(/^(?:[A-Za-z][A-Za-z ._-]{0,40} )?v?(\d{1,5}\.\d{1,5}\.\d{1,5})(?:[-+][0-9A-Za-z.-]{1,64})?(?:\s|$)/)?.[1] ?? null;
}
