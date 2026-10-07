import type { TaskWatch } from "@runweave/shared/task-supervision";
export function updateWaitingState(
  watch: TaskWatch,
  raw: string,
  toolName: string | null,
) {
  if (["sessionstart", "userpromptsubmit", "interrupt"].includes(raw)) {
    watch.revision++;
    watch.contextRevision++;
    watch.status = "watching";
    delete watch.waitingFor;
    delete watch.error;
    if (raw !== "interrupt") {
      watch.continuationCount = 0;
      watch.outcome = null;
      delete watch.pauseReason;
    }
  } else if (raw === "permissionrequest") watch.waitingFor = "permission";
  else if (
    raw === "pretooluse" &&
    /(?:^|[._/])request_user_input$/.test(toolName ?? "")
  )
    watch.waitingFor = "question";
  else if (raw === "posttooluse") delete watch.waitingFor;
  watch.updatedAt = new Date().toISOString();
}
