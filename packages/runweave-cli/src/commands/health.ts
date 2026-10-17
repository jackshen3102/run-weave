import { getStringOption, parseArgs, resolveOutputMode } from "../args.js";
import { resolveCliBaseUrl } from "../client/cli-base-url.js";
import { requestJson } from "../client/http.js";
import { CliError, HttpError } from "../errors.js";
import { writeOutput } from "../output/format.js";
import type { BackendHealthPayload } from "@runweave/shared/runtime-monitor";
import { serviceManagementSnapshot, type ServiceManagementSnapshot } from "@runweave/shared/service-management";
import type { RuntimeNodeStatusSnapshot } from "@runweave/shared/runtime-status";

interface HealthOutput {
  reachable: boolean;
  baseUrl: string;
  authenticated: boolean;
  profile: string;
  blockedByTunnelAuth: boolean;
  health?: BackendHealthPayload;
  message?: string;
  services?: ServiceManagementSnapshot["management"]["services"];
  coverage?: ServiceManagementSnapshot["management"]["coverage"];
  serviceCheck?: "available" | "unauthorized" | "unsupported" | "unavailable";
  serviceCheckMessage?: string;
}

export async function runHealthCommand(
  args: string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const parsed = parseArgs(args, new Set(["json", "plain"]));
  if (parsed.positionals.length) throw new CliError("Usage: rw health [--profile <name>] [--backend-port <port>] [--json]", 2);
  const mode = resolveOutputMode(parsed.options);
  const context = await resolveCliBaseUrl({
    profileName: getStringOption(parsed.options, "profile"),
    backendPort: getStringOption(parsed.options, "backend-port"),
    env: io.env,
  });

  let health: BackendHealthPayload;
  try {
    health = await requestJson<BackendHealthPayload>(context.baseUrl, "/health", { signal: AbortSignal.timeout(3_000) });
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
    writeOutput(io.stdout, mode, mode === "json" ? output : `Backend: unreachable (${output.baseUrl})\n${output.message}\n全部服务状态无法确认`);
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
  if (!output.authenticated) {
    output.serviceCheck = "unauthorized";
    output.serviceCheckMessage = "Backend 可达；登录后才能读取全部服务状态";
  } else {
    try {
      const snapshot = await requestJson<RuntimeNodeStatusSnapshot>(context.baseUrl, "/api/runtime-status", { headers: { Authorization: `Bearer ${context.accessToken}` }, signal: AbortSignal.timeout(3_000) });
      if (snapshot.protocolVersion !== 1 || !Array.isArray(snapshot.reports)) throw new CliError("Unsupported runtime status protocol", 3);
      const management = serviceManagementSnapshot(snapshot).management;
      output.services = management.services;
      output.coverage = management.coverage;
      output.serviceCheck = "available";
    } catch (error) {
      output.serviceCheck = error instanceof HttpError && error.status === 404 ? "unsupported" : "unavailable";
      output.serviceCheckMessage = output.serviceCheck === "unsupported" ? "当前 Backend 需更新后才能读取全部服务状态" : "全部服务状态未能读取，不能据 Backend 可达判断全部健康";
    }
  }
  writeOutput(io.stdout, mode, mode === "json" ? output : [
    `Backend: ${output.reachable ? "reachable" : "unreachable"} (${output.baseUrl})`,
    output.serviceCheckMessage,
    ...output.services?.map(service => `${service.label}: ${service.state}${service.installation === "restart-required" ? " · 需要重启" : ""} · ${service.summary}`) ?? [],
  ].filter(Boolean).join("\n"));
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
      signal: AbortSignal.timeout(3_000),
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
