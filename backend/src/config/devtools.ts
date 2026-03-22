export function resolveDevtoolsEnabled(env: NodeJS.ProcessEnv): boolean {
  const rawValue = env.BROWSER_DEVTOOLS_ENABLED?.trim().toLowerCase();
  if (!rawValue) {
    return true;
  }

  return rawValue !== "false";
}
