import type { BackendHealthPayload } from "@browser-viewer/shared";

export function buildHealthPayload(
  env: NodeJS.ProcessEnv,
): BackendHealthPayload {
  const runtimeReleaseId = env.RUNWEAVE_RUNTIME_RELEASE_ID?.trim();
  if (!runtimeReleaseId) {
    return { status: "ok" };
  }

  return {
    status: "ok",
    runtimeReleaseId,
  };
}
