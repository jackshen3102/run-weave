export function sanitizeTerminalProcessEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.npm_config_prefix;
  delete sanitized.NPM_CONFIG_PREFIX;
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
  delete process.env.npm_config_prefix;
  delete process.env.NPM_CONFIG_PREFIX;
  delete process.env.NO_COLOR;
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
