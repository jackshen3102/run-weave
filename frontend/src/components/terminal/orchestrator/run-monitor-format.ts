import type { OrchestratorRunPackage } from "@runweave/shared";

export const DO_A_IDEM_PHASES = [
  "discuss",
  "plan",
  "plan_review",
  "human_plan_approval",
  "code",
  "code_review",
  "human_verify",
  "finalize",
  "done",
] as const;

export function phaseLabel(
  phase: OrchestratorRunPackage["currentPhase"],
): string {
  if (phase === "discuss") {
    return "需求讨论";
  }
  if (phase === "plan") {
    return "计划";
  }
  if (phase === "plan_review") {
    return "计划审查";
  }
  if (phase === "human_plan_approval") {
    return "计划审批";
  }
  if (phase === "code") {
    return "代码执行";
  }
  if (phase === "code_review") {
    return "代码审查";
  }
  if (phase === "human_verify") {
    return "人工验收";
  }
  if (phase === "finalize") {
    return "收尾提交";
  }
  if (phase === "done") {
    return "完成";
  }
  return "未记录";
}

export function formatGoalTitle(goalId: string): string {
  const match = /^(.+?)_\d{8}_\d{3}_(.+)$/.exec(goalId);
  if (!match) {
    return goalId;
  }
  return `${match[1]} · ${match[2]}`;
}

export function formatTimelineTitle(title: string): string {
  if (title === "Worker result sent to orchestrator") {
    return title;
  }
  const workerResult = /^Worker result (.+)$/.exec(title);
  if (workerResult?.[1]) {
    return `Worker result · ${formatGoalTitle(workerResult[1])}`;
  }
  return title;
}

export function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

export function firstReadableLine(value?: string | null): string {
  return readableLines(value)[0] ?? "";
}

export function cleanSummaryText(value?: string | null): string {
  return readableLines(value).slice(0, 4).join("\n");
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const ESCAPE_CHAR = String.fromCharCode(27);
const BELL_CHAR = String.fromCharCode(7);
const OSC_SEQUENCE_PATTERN = new RegExp(
  `${ESCAPE_CHAR}\\][^${BELL_CHAR}]*(?:${BELL_CHAR}|${ESCAPE_CHAR}\\\\)`,
  "g",
);
const OSC_TITLE_SEQUENCE_PATTERN = new RegExp(
  `\\]0;[^${BELL_CHAR}\\n]*(?:${BELL_CHAR}|$)`,
  "g",
);
const ANSI_SEQUENCE_PATTERN = new RegExp(
  `${ESCAPE_CHAR}\\[[0-?]*[ -/]*[@-~]`,
  "g",
);
const REVERSE_INDEX_SEQUENCE_PATTERN = new RegExp(`${ESCAPE_CHAR}M`, "g");
const TERMINAL_CONTROL_CHARS_PATTERN = new RegExp(
  `[${BELL_CHAR}${ESCAPE_CHAR}]`,
  "g",
);

function readableLines(value?: string | null): string[] {
  return cleanDisplayText(value)
    .split("\n")
    .map((line) => trimTerminalNoiseSuffix(line.trim()))
    .filter((line) => line && !isTerminalNoiseLine(line))
    .slice(0, 8);
}

function cleanDisplayText(value?: string | null): string {
  return (value ?? "")
    .replace(OSC_SEQUENCE_PATTERN, "")
    .replace(OSC_TITLE_SEQUENCE_PATTERN, "")
    .replace(ANSI_SEQUENCE_PATTERN, "")
    .replace(REVERSE_INDEX_SEQUENCE_PATTERN, "")
    .replace(TERMINAL_CONTROL_CHARS_PATTERN, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function trimTerminalNoiseSuffix(value: string): string {
  const noiseIndex = [
    value.indexOf("•Working"),
    value.indexOf("•Explored"),
    value.indexOf("›"),
  ]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return noiseIndex == null ? value : value.slice(0, noiseIndex).trim();
}

function isTerminalNoiseLine(value: string): boolean {
  const spinnerFragments =
    value.match(/(?:Working|Workin|Worki|Wor|orking|rking|king|ngg)/g)
      ?.length ?? 0;
  return (
    (spinnerFragments >= 3 && !/[\u4e00-\u9fff]/.test(value)) ||
    (/^[─│└┌┐┘├┤┬┴┼]/.test(value) && !/[\u4e00-\u9fff]/.test(value)) ||
    /^[•\s]*(?:Working|Workin|Explored|Ran)\b/.test(value) ||
    /^[─•\s]+$/.test(value) ||
    /^›/.test(value)
  );
}
