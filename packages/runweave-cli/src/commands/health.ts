import { getStringOption, parseArgs, resolveOutputMode } from "../args.js";
import { resolveCliBaseUrl } from "../client/cli-base-url.js";
import { requestJson } from "../client/http.js";
import { CliError, HttpError } from "../errors.js";
import { writeOutput } from "../output/format.js";
import type { BackendHealthPayload } from "@runweave/shared/runtime-monitor";

interface HealthOutput {
  reachable: boolean;
  baseUrl: string;
  authenticated: boolean;
  profile: string;
  blockedByTunnelAuth: boolean;
  health?: BackendHealthPayload;
  message?: string;
}

export async function runHealthCommand(
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const parsed = parseArgs(args, new Set(["json", "plain"]));
  const mode = resolveOutputMode(parsed.options);
  const context = await resolveCliBaseUrl({
    profileName: getStringOption(parsed.options, "profile"),
    backendPort: getStringOption(parsed.options, "backend-port"),
    env: io.env,
  });

  let health: BackendHealthPayload;
  try {
    health = await requestJson<BackendHealthPayload>(context.baseUrl, "/health");
  } catch (error) {
    const output: HealthOutput = {
      reachable: false,
      baseUrl: context.baseUrl,
      authenticated: false,
      profile: context.profileName,
      blockedByTunnelAuth:
        error instanceof HttpError &&
        (error.status === 401 || error.status === 403),
      message: resolveHealthFailureMessage(error),
    };
    writeOutput(io.stdout, mode, output);
    throw new CliError(output.message ?? "Runweave backend is unreachable", 3);
  }

  const output: HealthOutput = {
    reachable: true,
    baseUrl: context.baseUrl,
    authenticated: await verifyAccessToken(context.baseUrl, context.accessToken),
    profile: context.profileName,
    blockedByTunnelAuth: false,
    health,
  };
  writeOutput(io.stdout, mode, output);
}

async function verifyAccessToken(
  baseUrl: string,
  accessToken: string | undefined,
): Promise<boolean> {
  if (!accessToken) {
    return false;
  }
  try {
    await requestJson<{ valid: boolean }>(baseUrl, "/api/auth/verify", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      return false;
    }
    throw error;
  }
}

function resolveHealthFailureMessage(error: unknown): string {
  if (
    error instanceof HttpError &&
    (error.status === 401 || error.status === 403)
  ) {
    return "Runweave health check is blocked by tunnel auth";
  }
  return error instanceof Error
    ? error.message
    : "Runweave backend is unreachable";
}
