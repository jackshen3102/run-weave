import {
  isTerminalBrowserProfileId,
  type ResolvedTerminalBrowserProfile,
  type TerminalBrowserErrorPayload,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { CliError } from "../errors.js";
import { isRemoteBrowserProfileState, type RemoteBrowserResolveResponse } from "@runweave/shared/remote";

export interface BrowserCommandIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  env: NodeJS.ProcessEnv;
}

interface ResolveOptions {
  profileId: TerminalBrowserProfileId | null;
  groupId: string | null;
  json: boolean;
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
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
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
  return { profileId, groupId, json };
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
): Promise<ResolvedTerminalBrowserProfile> {
  const terminalSessionId = io.env.RUNWEAVE_TERMINAL_SESSION_ID?.trim();
  const projectId = io.env.RUNWEAVE_PROJECT_ID?.trim();
  const hookToken = io.env.RUNWEAVE_HOOK_TOKEN?.trim();
  const base = io.env.RUNWEAVE_BASE_URL?.trim() ||
    (io.env.RUNWEAVE_BACKEND_PORT ? `http://127.0.0.1:${io.env.RUNWEAVE_BACKEND_PORT}` : "");
  if (!terminalSessionId || !projectId || !hookToken || !base) {
    throw new CliError("REMOTE_CAPABILITY_UNSUPPORTED: Remote Browser identity is unavailable", 3);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
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
      throw new CliError(`REMOTE_CAPABILITY_UNSUPPORTED: capability request returned HTTP ${capabilityResponse.status}`, 3);
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
      throw new CliError(`${error?.code ?? "DESKTOP_UNAVAILABLE"}: ${error?.message ?? `HTTP ${response.status}`}`, response.status === 403 ? 4 : 3);
    }
    const resolved = (await response.json()) as RemoteBrowserResolveResponse;
    if (!isRemoteBrowserProfileState(resolved)) {
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
    throw new CliError(`DESKTOP_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`, 3);
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveBrowserProfile(
  args: string[],
  io: BrowserCommandIo,
): Promise<ResolvedTerminalBrowserProfile> {
  const options = parseResolveOptions(args);
  if (!io.env.PLAYWRIGHT_MCP_CDP_ENDPOINT?.trim() &&
      (io.env.RUNWEAVE_TERMINAL_SESSION_ID || io.env.RUNWEAVE_PROJECT_ID)) {
    return resolveRemoteBrowserProfile(options, io);
  }
  const ambient = parseAmbientEndpoint(io.env.PLAYWRIGHT_MCP_CDP_ENDPOINT);
  const projectId = io.env.RUNWEAVE_PROJECT_ID?.trim() || null;
  const groupId = options.groupId ?? ambient.ambientGroupId;
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    response = await fetch(ambient.resolverUrl, {
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
  } catch (error) {
    throw new CliError(
      `Terminal Browser Profile resolver is unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
      3,
    );
  } finally {
    clearTimeout(timeout);
  }

  let result: ResolvedTerminalBrowserProfile;
  if (response.status === 404) {
    throw new CliError("This Runweave version does not provide Browser Profile state; update the desktop", 3);
  } else if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: TerminalBrowserErrorPayload;
    } | null;
    const error = body?.error;
    throw new CliError(
      error
        ? `${error.code}: ${error.message}`
        : `Profile resolver returned HTTP ${response.status}`,
      response.status === 400 ? 2 : response.status === 409 ? 4 : 3,
    );
  } else {
    result = (await response.json()) as ResolvedTerminalBrowserProfile;
  }

  return result;
}
