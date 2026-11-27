import type { AgyAgentContext } from "@runweave/shared/terminal/agy-agent";
import type { ClaudeAgentContext } from "@runweave/shared/terminal/claude-agent";
import type { AgentHookStateEvent } from "@runweave/shared/terminal/events";
import type { PiAgentContext } from "@runweave/shared/terminal/pi-agent";
import type { TerminalMobilePrompts } from "../questions/origin";

export function observeAgyMobilePrompt(
  prompts: TerminalMobilePrompts | undefined,
  sessionId: string,
  panelId: string | null,
  hookEvent: AgentHookStateEvent,
  toolName: string | null | undefined,
  toolUseId: string | null | undefined,
  agy: AgyAgentContext,
): void {
  if (!prompts) return;
  if (hookEvent === "ToolRequested" && toolName === "ask_question") {
    prompts.observePrompt({
      terminalId: sessionId,
      panelId,
      source: "agy",
      actionKind: "question",
      dedupeKey: `agy:ask_question:${agy.conversationId}:${toolUseId ?? agy.eventId}`,
      title: "AGY 等你回答",
      body: "打开 Runweave 回到原终端确认选项。",
      specificity: 350,
      ...(toolUseId ? { toolUseId } : {}),
    });
  } else if (hookEvent === "ToolCompleted" || hookEvent === "UserPromptSubmit" || hookEvent === "Stop") {
    prompts.resolvePrompt(
      sessionId,
      panelId,
      hookEvent === "Stop" ? "closed" : "resolved",
      hookEvent === "ToolCompleted" && toolUseId ? { toolUseId } : undefined,
    );
  }
}

export function observeClaudeMobilePrompt(
  prompts: TerminalMobilePrompts | undefined,
  sessionId: string,
  panelId: string | null,
  hookEvent: AgentHookStateEvent,
  toolName: string | null | undefined,
  toolUseId: string | null | undefined,
  claude: ClaudeAgentContext,
): void {
  if (!prompts) return;
  if (claude.event === "permissionrequest") {
    prompts.observePrompt({
      terminalId: sessionId,
      panelId,
      source: "claude",
      actionKind: "permission",
      dedupeKey: `claude:perm:${claude.sessionId}:${claude.instanceId}:${claude.eventId}`,
      title: "Claude 请求执行权限",
      body: "打开 Runweave 回到原终端确认权限。",
      specificity: 300,
    });
  } else if (hookEvent === "ToolRequested" && toolName === "AskUserQuestion") {
    prompts.observePrompt({
      terminalId: sessionId,
      panelId,
      source: "claude",
      actionKind: "question",
      dedupeKey: `claude:question:${claude.sessionId}:${toolUseId ?? claude.eventId}`,
      title: "Claude 等你回答",
      body: "打开 Runweave 回到原终端确认选项。",
      specificity: 350,
      ...(toolUseId ? { toolUseId } : {}),
    });
  } else if (
    ["posttooluse", "posttoolusefailure", "userpromptsubmit"].includes(claude.event) ||
    (claude.event === "pretooluse" && toolName !== "AskUserQuestion")
  ) {
    prompts.resolvePrompt(
      sessionId,
      panelId,
      "resolved",
      hookEvent === "ToolCompleted" && toolUseId ? { toolUseId } : undefined,
    );
  } else if (
    claude.event === "stop" ||
    claude.event === "sessionend" ||
    (claude.event === "notification" && claude.notificationType === "idle_prompt")
  ) {
    prompts.resolvePrompt(sessionId, panelId, "closed");
  }
}

export function observePiMobilePrompt(
  prompts: TerminalMobilePrompts | undefined,
  sessionId: string,
  panelId: string | null,
  pi: PiAgentContext,
): void {
  if (!prompts) return;
  if (pi.event === "ui_prompt_start") {
    prompts.observePrompt({
      terminalId: sessionId,
      panelId,
      source: "pi",
      actionKind: "agent_prompt",
      dedupeKey: `pi:prompt:${pi.instanceId}:${pi.sequence}`,
      title: "Pi 等你确认",
      body: "打开 Runweave 回到原终端继续处理。",
      specificity: 300,
    });
  } else {
    prompts.resolvePrompt(sessionId, panelId, pi.event === "ui_prompt_end" ? "resolved" : "closed");
  }
}
