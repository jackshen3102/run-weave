export function sanitizeTerminalProcessEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.npm_config_prefix;
  delete sanitized.NPM_CONFIG_PREFIX;
  return sanitized;
}

export function sanitizeCurrentTerminalProcessEnv(): void {
  delete process.env.npm_config_prefix;
  delete process.env.NPM_CONFIG_PREFIX;
}
