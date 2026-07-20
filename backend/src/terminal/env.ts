export function isNpmProcessEnvName(name: string): boolean {
  return name.toLowerCase().startsWith("npm_");
}

function removeNpmProcessEnv(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (isNpmProcessEnvName(name)) {
      delete env[name];
    }
  }
}

export function sanitizeTerminalProcessEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  removeNpmProcessEnv(sanitized);
  delete sanitized.NO_COLOR;
  delete sanitized.ELECTRON_RUN_AS_NODE;
  delete sanitized.FRONTEND_DIST_DIR;

  if (isDisabledColorFlag(sanitized.FORCE_COLOR)) {
    delete sanitized.FORCE_COLOR;
  }
  if (sanitized.CLICOLOR?.trim() === "0") {
    delete sanitized.CLICOLOR;
  }

  return sanitized;
}

export function sanitizeCurrentTerminalProcessEnv(): void {
  removeNpmProcessEnv(process.env);
  delete process.env.NO_COLOR;
  delete process.env.ELECTRON_RUN_AS_NODE;
  if (isDisabledColorFlag(process.env.FORCE_COLOR)) {
    delete process.env.FORCE_COLOR;
  }
  if (process.env.CLICOLOR?.trim() === "0") {
    delete process.env.CLICOLOR;
  }
}

function isDisabledColorFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "0" || normalized === "false";
}
