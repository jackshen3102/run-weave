import type {
  ScheduledRunStatus,
  TaskSchedule,
} from "@runweave/shared/scheduled-tasks";
import { HttpError } from "../../services/http";

export const fieldClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm";
export const statusLabel: Record<ScheduledRunStatus, string> = {
  queued: "排队中",
  running: "执行中",
  stopping: "正在停止",
  waiting: "等待处理",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  skipped: "已跳过",
};
export function displayTime(
  time: string | null | undefined,
  timezone?: string,
) {
  if (!time) return "—";
  try {
    return new Date(time).toLocaleString("zh-CN", {
      timeZone: timezone,
      hour12: false,
    });
  } catch {
    return time;
  }
}
export function scheduleLabel(schedule: TaskSchedule) {
  if (schedule.kind === "once")
    return `仅一次 · ${displayTime(schedule.runAt, schedule.timezone)} · ${schedule.timezone}`;
  const days =
    schedule.kind === "weekly"
      ? schedule.weekdays.map((day) => `周${"日一二三四五六"[day]}`).join("、")
      : schedule.kind === "daily"
        ? "每天"
        : "工作日";
  return `${days} ${schedule.localTime} · ${schedule.timezone}`;
}
export function safeArtifactUrl(url?: string) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol)
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function errorMessage(error: unknown) {
  if (error instanceof HttpError) {
    if (error.status === 404)
      return "当前连接找不到此资源，或 Backend 尚未支持定时任务，请检查连接及版本。";
    if (error.status === 409)
      return `发生冲突：${error.message}。请刷新后重试；编辑草稿已保留，可复制后重新编辑。`;
    if (error.status === 503) return `服务暂不可用：${error.message}`;
    return `${error.message}${error.code ? ` (${error.code})` : ""}`;
  }
  return error instanceof Error
    ? `请求失败：${error.message}。请检查 Backend 连接。`
    : String(error);
}
export function RequestError({ error }: { error: unknown }) {
  const details = error instanceof HttpError ? error.details : null;
  const fields =
    details &&
    typeof details === "object" &&
    "fieldErrors" in details &&
    details.fieldErrors &&
    typeof details.fieldErrors === "object"
      ? Object.entries(details.fieldErrors).flatMap(([field, message]) =>
          typeof message === "string" ? [`${field}：${message}`] : [],
        )
      : [];
  return error ? (
    <div
      role="alert"
      className="break-words rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {errorMessage(error)}
      {fields.map((field) => (
        <p key={field}>{field}</p>
      ))}
    </div>
  ) : null;
}
