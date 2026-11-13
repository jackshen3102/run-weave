import {
  isTerminalBrowserProfileId,
  type ResolvedTerminalBrowserProfile,
  type TerminalBrowserErrorPayload,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { CliError } from "../errors.js";
import { isRemoteBrowserProfileState, type RemoteBrowserResolveResponse } from "@runweave/shared/remote";
import type { TerminalSessionIdentityResponse } from "@runweave/shared/terminal/session";
import { resolveRunweaveBaseUrl } from "../config/profile-store.js";
import { verifyBackendEnvironment } from "../client/environment.js";
import { ConfigurationError } from "@runweave/config-node";

export interface BrowserCommandIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
  onBrowserStage?: (stage: "identity" | "binding", passed: boolean) => void;
}

interface ResolveOptions {
  profileId: TerminalBrowserProfileId | null;
  groupId: string | null;
  json: boolean;
  waitTimeoutMs: number;
  deadline?: number;
}

class BrowserProfileTemporaryError extends CliError {}

function requestTimeout(options: ResolveOptions): number {
  return Math.max(1, Math.min(5000, (options.deadline ?? Date.now() + 5000) - Date.now()));
}

function resolveError(status: number, code: string | undefined, message: string): CliError {
  const retryable = (status === 429 || status >= 500) &&
    !["BROWSER_BINDING_REQUIRED", "BROWSER_SCOPE_DENIED", "REMOTE_CAPABILITY_UNSUPPORTED"].includes(code ?? "");
  return retryable ? new BrowserProfileTemporaryError(message, 3)
    : new CliError(message, status === 400 ? 2 : status === 403 || status === 409 ? 4 : 3);
}

function parseProfile(value: string): TerminalBrowserProfileId {
  const profileId = `profile-${value}`;
  if (!isTerminalBrowserProfileId(profileId)) {
    throw new CliError("--profile must be one of: 1, 2, 3", 2);
  }
  return profileId;
}

function parseResolveOptions(args: string[]): ResolveOptions {
  let profileId: TerminalBrowserProfileId | null = null;
  let groupId: string | null = null;
  let json = false;
  let waitTimeoutMs = 30000;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--wait-timeout-ms") {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value) || Number(value) > 120000)
        throw new CliError("--wait-timeout-ms must be an integer from 0 to 120000", 2);
      waitTimeoutMs = Number(value);
      continue;
    }
    if (arg === "--profile" || arg === "--group-id") {
      const value = args[index + 1];
      if (!value) {
        throw new CliError(`${arg} requires a value`, 2);
      }
      index += 1;
      if (arg === "--profile") {
        profileId = parseProfile(value);
      } else {
        if (value.trim() !== value || value.length > 512) {
          throw new CliError("--group-id must be at most 512 characters", 2);
        }
        groupId = value;
      }
      continue;
    }
    throw new CliError(`Unknown browser profile option: ${arg}`, 2);
  }
  return { profileId, groupId, json, waitTimeoutMs };
}

function parseAmbientEndpoint(raw: string | undefined): {
  resolverUrl: string;
  ambientGroupId: string | null;
} {
  if (!raw?.trim()) {
    throw new CliError("PLAYWRIGHT_MCP_CDP_ENDPOINT is required", 3);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError("PLAYWRIGHT_MCP_CDP_ENDPOINT must be a URL", 2);
  }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
  if (
    !["http:", "ws:"].includes(parsed.protocol) ||
    !loopbackHosts.has(parsed.hostname) ||
    !parsed.port
  ) {
    throw new CliError(
      "PLAYWRIGHT_MCP_CDP_ENDPOINT must use loopback HTTP or WebSocket with an explicit port",
      2,
    );
  }
  return {
    resolverUrl: `http://127.0.0.1:${parsed.port}/runweave/browser-profile/resolve`,
    ambientGroupId: parsed.searchParams.get("groupId")?.trim() || null,
  };
}

async function resolveRemoteBrowserProfile(
  options: ResolveOptions,
  io: BrowserCommandIo,
  projectId: string | null,
): Promise<ResolvedTerminalBrowserProfile> {
  const terminalSessionId = io.env.RUNWEAVE_TERMINAL_SESSION_ID?.trim();
  const hookToken = io.env.RUNWEAVE_HOOK_TOKEN?.trim();
  const base = io.env.RUNWEAVE_BASE_URL?.trim() ||
    (io.env.RUNWEAVE_BACKEND_PORT ? `http://127.0.0.1:${io.env.RUNWEAVE_BACKEND_PORT}` : "");
  if (!terminalSessionId || !projectId || !hookToken || !base) {
    throw new CliError("REMOTE_CAPABILITY_UNSUPPORTED: Remote Browser identity is unavailable", 3);
  }
  io.onBrowserStage?.("identity", true);
  io.onBrowserStage?.("binding", false);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeout(options));
  try {
    const capabilityResponse = await fetch(
      `${base.replace(/\/+$/, "")}/api/terminal/session/${encodeURIComponent(terminalSessionId)}/browser/capability`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-runweave-hook-token": hookToken },
        body: JSON.stringify({ projectId }),
        signal: controller.signal,
      },
    );
    if (!capabilityResponse.ok) {
      const error = await capabilityResponse.json().catch(() => null) as {code?:string;message?:string}|null;
      throw resolveError(capabilityResponse.status, error?.code,
        `${error?.code ?? "REMOTE_CAPABILITY_UNSUPPORTED"}: ${error?.message ?? `HTTP ${capabilityResponse.status}`}`);
    }
    const issued = (await capabilityResponse.json()) as { capability?: string };
    if (!issued.capability) throw new CliError("REMOTE_CAPABILITY_UNSUPPORTED: missing terminal capability", 3);
    const response = await fetch(
      `${base.replace(/\/+$/, "")}/api/terminal/session/${encodeURIComponent(terminalSessionId)}/browser/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${issued.capability}` },
        body: JSON.stringify({
          projectId,
          explicitProfileId: options.profileId,
          browserGroupId: options.groupId,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
      throw resolveError(response.status, error?.code,
        `${error?.code ?? "DESKTOP_UNAVAILABLE"}: ${error?.message ?? `HTTP ${response.status}`}`);
    }
    const resolved = (await response.json()) as RemoteBrowserResolveResponse;
    if (resolved.protocolVersion !== 2 || resolved.binding?.protocolVersion !== 2 || !isRemoteBrowserProfileState(resolved)) {
      throw new CliError("REMOTE_CAPABILITY_UNSUPPORTED: Desktop Browser Profile state is missing or invalid; update the desktop, remote Backend and CLI together", 3);
    }
    return {
      profileId: resolved.profileId,
      source: resolved.source,
      projectId,
      route: resolved.route,
      cdpEndpoint: resolved.cdpEndpoint,
      browserGroupId: resolved.browserGroupId,
      automationAttribution: "terminal",
      whistle: resolved.whistle,
    };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new BrowserProfileTemporaryError(`DESKTOP_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`, 3);
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCurrentProjectId(io: BrowserCommandIo, options: ResolveOptions): Promise<string | null> {
  const fallback = io.env.RUNWEAVE_PROJECT_ID?.trim() || null;
  const id = io.env.RUNWEAVE_TERMINAL_SESSION_ID?.trim();
  const hookToken = io.env.RUNWEAVE_HOOK_TOKEN?.trim();
  const base = io.env.RUNWEAVE_BASE_URL?.trim() ||
    (io.env.RUNWEAVE_BACKEND_PORT ? `http://127.0.0.1:${io.env.RUNWEAVE_BACKEND_PORT}` : "");
  if (!id || !hookToken || !base) return fallback;
  try {
    const response = await fetch(`${base.replace(/\/+$/, "")}/api/terminal/session/${encodeURIComponent(id)}/runtime-identity`, {
      headers: { "x-runweave-hook-token": hookToken }, signal: AbortSignal.timeout(requestTimeout(options)),
    });
    // Older Backends do not expose this hook-authenticated route.
    if (response.status === 404 || response.status === 401) {
      if (response.status === 404) {
        const error = await response.json().catch(() => null) as { code?: string } | null;
        if (error?.code === "terminal_session_not_found") throw new CliError("Terminal session not found", 3);
      }
      io.stderr.write("Warning: Backend cannot refresh terminal project identity; using launch environment.\n");
      return fallback;
    }
    if (!response.ok) throw resolveError(response.status, undefined, `Terminal project identity is unavailable: HTTP ${response.status}`);
    const identity = await response.json() as TerminalSessionIdentityResponse;
    if (identity.terminalSessionId !== id || typeof identity.projectId !== "string" || !identity.projectId.trim()) {
      throw new CliError("Invalid terminal identity", 3);
    }
    return identity.projectId;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new BrowserProfileTemporaryError(`Terminal project identity is unavailable: ${error instanceof Error ? error.message : String(error)}`, 3);
  }
}

async function resolveBrowserProfileAttempt(
  options: ResolveOptions,
  io: BrowserCommandIo,
): Promise<ResolvedTerminalBrowserProfile> {
  io.onBrowserStage?.("identity", false);
  if (!io.env.PLAYWRIGHT_MCP_CDP_ENDPOINT?.trim() &&
      !io.env.RUNWEAVE_BASE_URL?.trim() && !io.env.RUNWEAVE_BACKEND_PORT?.trim() &&
      io.env.RUNWEAVE_TERMINAL_SESSION_ID?.trim() && io.env.RUNWEAVE_HOOK_TOKEN?.trim()) {
    // Verify the configured local instance before sending an old PTY's token.
    const baseUrl = resolveRunweaveBaseUrl({});
    try {
      await verifyBackendEnvironment(baseUrl, AbortSignal.timeout(requestTimeout(options)));
    } catch (error) {
      if (error instanceof ConfigurationError && error.code !== "CONFIG_TARGET_UNVERIFIED") throw error;
      throw new BrowserProfileTemporaryError("DESKTOP_UNAVAILABLE: Terminal Backend discovery is unavailable", 3);
    }
    io = { ...io, env: { ...io.env, RUNWEAVE_BASE_URL: baseUrl } };
  }
  const projectId = await resolveCurrentProjectId(io, options);
  if (!io.env.PLAYWRIGHT_MCP_CDP_ENDPOINT?.trim() &&
      (io.env.RUNWEAVE_TERMINAL_SESSION_ID || io.env.RUNWEAVE_PROJECT_ID)) {
    return resolveRemoteBrowserProfile(options, io, projectId);
  }
  const ambient = parseAmbientEndpoint(io.env.PLAYWRIGHT_MCP_CDP_ENDPOINT);
  io.onBrowserStage?.("identity", true);
  io.onBrowserStage?.("binding", false);
  const groupId = options.groupId ?? (io.env.RUNWEAVE_BROWSER_GROUP_ID?.trim() || null) ?? ambient.ambientGroupId;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeout(options));
  try {
    const response = await fetch(ambient.resolverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        explicitProfileId: options.profileId,
        browserGroupId: groupId,
        terminalSessionId: io.env.RUNWEAVE_TERMINAL_SESSION_ID?.trim() || null,
      }),
      signal: controller.signal,
    });
    if (response.status === 404)
      throw new CliError("This Runweave version does not provide Browser Profile state; update the desktop", 3);
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: TerminalBrowserErrorPayload } | null;
      const error = body?.error;
      throw resolveError(response.status, error?.code,
        error ? `${error.code}: ${error.message}` : `Profile resolver returned HTTP ${response.status}`);
    }
    return await response.json() as ResolvedTerminalBrowserProfile;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof SyntaxError) throw new CliError("Profile resolver returned invalid JSON", 3);
    throw new BrowserProfileTemporaryError(
      `Terminal Browser Profile resolver is unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      3,
    );
  } finally {
    clearTimeout(timeout);
  }

}

export async function resolveBrowserProfile(args: string[], io: BrowserCommandIo): Promise<ResolvedTerminalBrowserProfile> {
  const options = parseResolveOptions(args);
  options.deadline = Date.now() + (options.waitTimeoutMs || 5000);
  let attempt = 0;
  for (;;) {
    try {
      const resolved = await resolveBrowserProfileAttempt(options, io);
      io.onBrowserStage?.("binding", true);
      return resolved;
    }
    catch (error) {
      if (!(error instanceof BrowserProfileTemporaryError) || !options.waitTimeoutMs || Date.now() >= options.deadline)
        throw error;
      if (!attempt) io.stderr.write("Browser is reconnecting; waiting for the authorized channel.\n");
      const delay = Math.min(1000 * 2 ** Math.min(attempt++, 3), 5000, options.deadline - Date.now());
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
