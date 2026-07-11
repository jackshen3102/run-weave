import type { BackendHealthPayload } from "@runweave/shared/runtime-monitor";

export function buildHealthPayload(
  env: NodeJS.ProcessEnv,
  identity?: { backendId: string },
): BackendHealthPayload {
  const runtimeReleaseId = env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim();
  return {
    status: "ok",
    ...(identity
      ? {
          service: "runweave-backend" as const,
          serviceInstanceId: `backend:${identity.backendId}`,
          protocolVersion: 1,
          capabilities: ["dev-session-identity-v1"],
        }
      : {}),
    ...(env.RUNWEAVE_DEV_SESSION_ID?.trim()
      ? { devSessionId: env.RUNWEAVE_DEV_SESSION_ID.trim() }
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
