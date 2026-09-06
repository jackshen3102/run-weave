import type { RuntimeServices } from "./runtime-services";

export function setBackendRuntimeStatusListener(
  services: RuntimeServices,
  input: { host?: string; port: number },
): string {
  const baseUrl = `http://127.0.0.1:${input.port}`;
  services.runtimeStatus.listener = {
    baseUrl,
    host: input.host ?? "0.0.0.0",
    port: input.port,
  };
  process.env.RUNWEAVE_BASE_URL = baseUrl;
  process.env.RUNWEAVE_BACKEND_PORT = String(input.port);
  process.env.RUNWEAVE_HOOK_ENDPOINT = `${baseUrl}/internal/terminal/agent-hook`;
  process.env.RUNWEAVE_COMPLETION_HOOK_ENDPOINT = `${baseUrl}/internal/terminal-completion`;
  return baseUrl;
}
