import { configuration } from "@runweave/config-node";
import type { BackendHealthPayload } from "@runweave/shared/runtime-monitor";

export function buildHealthPayload(
  env: NodeJS.ProcessEnv,
  identity?: { backendId: string },
): BackendHealthPayload {
  const runtimeReleaseId = env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim();
  return {
    status: "ok",
    environment: configuration().context,
    ...(identity
      ? {
          service: "runweave-backend" as const,
          serviceInstanceId: `backend:${identity.backendId}`,
          protocolVersion: 1,
          capabilities: ["dev-session-identity-v1"],
        }
      : {}),
    ...(configuration().context.kind === "dev"
      ? { devSessionId: configuration().context.instanceId }
      : {}),
    ...(env.RUNWEAVE_SOURCE_REVISION?.trim()
      ? { sourceRevision: env.RUNWEAVE_SOURCE_REVISION.trim() }
      : {}),
    ...(env.RUNWEAVE_RESOURCE_NAMESPACE?.trim()
      ? { resourceNamespace: env.RUNWEAVE_RESOURCE_NAMESPACE.trim() }
      : {}),
    ...(runtimeReleaseId ? { runtimeReleaseId } : {}),
  };
}
