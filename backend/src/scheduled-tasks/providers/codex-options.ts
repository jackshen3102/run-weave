import type { ScheduledTaskConfig } from "@runweave/shared/scheduled-tasks";

export function codexScheduledArgs(
  config: Pick<ScheduledTaskConfig, "model" | "effort" | "executionPolicy">,
): string[] {
  return [
    ...(config.executionPolicy === "auto-review"
      ? ["--approve-for-me"]
      : [
          "--sandbox",
          "workspace-write",
          "--config",
          'approval_policy="never"',
        ]),
    "--config",
    "sandbox_workspace_write.network_access=false",
    ...(config.model ? ["--model", config.model] : []),
    ...(config.effort
      ? ["--config", `model_reasoning_effort=${JSON.stringify(config.effort)}`]
      : []),
  ];
}
