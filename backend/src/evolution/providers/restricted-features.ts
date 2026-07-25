const DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "shell_tool",
  "tool_suggest",
] as const;

export function buildEvolutionRestrictedFeatureArgs(): string[] {
  return DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]);
}
