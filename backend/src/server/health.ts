import { runtimeBuildInfo } from "@runweave/shared/runtime-version";
import { configuration } from "@runweave/config-node";
import type { BackendHealthPayload } from "@runweave/shared/runtime-monitor";

declare const __RUNWEAVE_BACKEND_SOURCE_REVISION__: string;
declare const __RUNWEAVE_BACKEND_SOURCE_DIRTY__: boolean;

export function buildHealthPayload(
  env: NodeJS.ProcessEnv,
  identity?: { backendId: string },
): BackendHealthPayload {
  const runtimeReleaseId = env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim();
  // An external runtime can be newer than the Electron shell supplying its env.
  const buildInfo = runtimeBuildInfo();
  const sourceRevision = buildInfo.sourceRevision ?? (typeof __RUNWEAVE_BACKEND_SOURCE_REVISION__ === "string"
    ? __RUNWEAVE_BACKEND_SOURCE_REVISION__ : env.RUNWEAVE_SOURCE_REVISION?.trim());
  const sourceDirty = buildInfo.sourceDirty ?? (typeof __RUNWEAVE_BACKEND_SOURCE_DIRTY__ === "boolean" ? __RUNWEAVE_BACKEND_SOURCE_DIRTY__ : undefined);
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
    ...(sourceRevision
      ? { sourceRevision }
      : {}),
    ...(sourceDirty === undefined ? {} : { sourceDirty }),
    ...(env.RUNWEAVE_RESOURCE_NAMESPACE?.trim()
      ? { resourceNamespace: env.RUNWEAVE_RESOURCE_NAMESPACE.trim() }
      : {}),
    ...(runtimeReleaseId ? { runtimeReleaseId } : {}),
  };
}
