import type {
  SupervisionHookRequest,
  TaskWatch,
} from "@runweave/shared/task-supervision";
export function updateWaitingState(
  watch: TaskWatch,
  event: SupervisionHookRequest,
) {
  if (watch.status !== "watching") return;
  if (event.event === "PermissionRequest") watch.waitingFor = "permission";
  else if (
    event.event === "PreToolUse" &&
    /(?:^|[._/])request_user_input$/.test(event.toolName ?? "")
  )
    watch.waitingFor = "question";
  else if (event.event === "PostToolUse") delete watch.waitingFor;
  else return;
  watch.updatedAt = new Date().toISOString();
}
