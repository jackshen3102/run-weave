export function resolveNodePtyDirectory(
  env: NodeJS.ProcessEnv,
): string | null {
  const configured = env.BROWSER_VIEWER_NODE_PTY_DIR?.trim();
  return configured ? configured : null;
}
