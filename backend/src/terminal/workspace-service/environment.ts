import type { WorkspaceServiceDefinition } from "./config";

const REMOVED_ENV_NAMES = new Set([
  "ELECTRON_RUN_AS_NODE",
  "FRONTEND_DIST_DIR",
  "NO_COLOR",
]);

function peerEnvironmentName(serviceName: string): string {
  return `RUNWEAVE_SERVICE_${serviceName.replaceAll("-", "_").toUpperCase()}_URL`;
}

export function buildWorkspaceServiceEnvironment(input: {
  definitions: WorkspaceServiceDefinition[];
  env?: NodeJS.ProcessEnv;
  host: string;
  port: number;
  projectId: string;
  serviceName: string;
  serviceUrls: ReadonlyMap<string, string>;
}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env ?? process.env)) {
    if (
      value === undefined ||
      name.startsWith("RUNWEAVE_") ||
      name.toLowerCase().startsWith("npm_") ||
      REMOVED_ENV_NAMES.has(name)
    ) {
      continue;
    }
    environment[name] = value;
  }

  environment.HOST = input.host;
  environment.PORT = String(input.port);
  environment.RUNWEAVE_SERVICE_HOST = input.host;
  environment.RUNWEAVE_SERVICE_PORT = String(input.port);
  environment.RUNWEAVE_SERVICE_NAME = input.serviceName;
  environment.RUNWEAVE_PROJECT_ID = input.projectId;
  environment.RUNWEAVE_SERVICE_URL =
    input.serviceUrls.get(input.serviceName) ?? "";

  for (const definition of input.definitions) {
    const url = input.serviceUrls.get(definition.name);
    if (url) {
      environment[peerEnvironmentName(definition.name)] = url;
    }
  }
  return environment;
}
