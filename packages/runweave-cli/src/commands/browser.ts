import {
  isTerminalBrowserProfileId,
  type ResolvedTerminalBrowserProfile,
  type TerminalBrowserErrorPayload,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { CliError } from "../errors.js";

const USAGE =
  "Usage: rw browser profile resolve [--profile 1|2|3] [--group-id <id>] [--json]";

interface BrowserCommandIo {
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
  ambientEndpoint: string;
  ambientGroupId: string | null;
  ambientProfileId: TerminalBrowserProfileId | null;
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
  const ambientProfile = parsed.searchParams.get("profileId");
  return {
    resolverUrl: `http://127.0.0.1:${parsed.port}/runweave/browser-profile/resolve`,
    ambientEndpoint: raw,
    ambientGroupId: parsed.searchParams.get("groupId")?.trim() || null,
    ambientProfileId: isTerminalBrowserProfileId(ambientProfile)
      ? ambientProfile
      : null,
  };
}

function fallbackResolution(
  ambientEndpoint: string,
  profileId: TerminalBrowserProfileId | null,
  projectId: string | null,
): ResolvedTerminalBrowserProfile {
  const resolvedProfileId = profileId ?? "profile-1";
  return {
    profileId: resolvedProfileId,
    source: "global-default",
    projectId,
    route: { kind: "unassigned" },
    cdpEndpoint: ambientEndpoint,
    whistle: {
      profileId: resolvedProfileId,
      status: "stopped",
      host: "127.0.0.1",
      port:
        resolvedProfileId === "profile-1"
          ? 8081
          : resolvedProfileId === "profile-2"
            ? 8082
            : 8083,
      storage: resolvedProfileId,
      pid: null,
      error: null,
    },
  };
}

async function resolveProfile(
  args: string[],
  io: BrowserCommandIo,
): Promise<void> {
  const options = parseResolveOptions(args);
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
    if (options.profileId) {
      throw new CliError(
        "This Runweave version does not support explicit Terminal Browser Profile selection",
        4,
      );
    }
    io.stderr.write(
      "Warning: Terminal Browser Profile resolver is unavailable; using the ambient endpoint. Worktree Profile bindings are not supported by this Runweave version.\n",
    );
    result = fallbackResolution(
      ambient.ambientEndpoint,
      ambient.ambientProfileId,
      projectId,
    );
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

  if (options.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  io.stdout.write(`${result.cdpEndpoint}\n`);
}

export async function runBrowserCommand(
  subcommand: string | undefined,
  args: string[],
  io: BrowserCommandIo,
): Promise<void> {
  if (subcommand !== "profile" || args[0] !== "resolve") {
    throw new CliError(USAGE, 2);
  }
  await resolveProfile(args.slice(1), io);
}
